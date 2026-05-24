package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/api/iterator"
)

const (
	relationshipsCollection = "relationships"
	reflectionsCollection   = "reflections"
)

type backfillStats struct {
	scanned          int
	updated          int
	skippedRecent    int
	noReflection     int
	writeErrors      int
	matchedBySender  int
	matchedByScan    int
	noReflectionDocs []string
}

func main() {
	var (
		apply      bool
		projectID  string
		explorerID string
	)

	flag.BoolVar(&apply, "apply", false, "Write lastReflectionSentAt values to Firestore (default is dry-run)")
	flag.StringVar(&projectID, "project", "", "GCP project ID (overrides GOOGLE_CLOUD_PROJECT)")
	flag.StringVar(&explorerID, "explorer", "", "Optional explorerId filter (e.g. COLE-01052010)")
	flag.Parse()

	if projectID == "" {
		projectID = os.Getenv("GOOGLE_CLOUD_PROJECT")
	}
	if projectID == "" {
		log.Fatal("Missing project ID. Set GOOGLE_CLOUD_PROJECT or pass -project <id>.")
	}

	ctx := context.Background()
	client, err := firestore.NewClient(ctx, projectID)
	if err != nil {
		log.Fatalf("Failed to create Firestore client: %v", err)
	}
	defer client.Close()

	mode := "DRY RUN"
	if apply {
		mode = "APPLY"
	}
	fmt.Printf("Starting lastReflectionSentAt backfill [%s] for project %s\n", mode, projectID)
	if explorerID != "" {
		fmt.Printf("Explorer filter: %s\n", explorerID)
	}

	stats, err := backfillRelationships(ctx, client, apply, explorerID)
	if err != nil {
		log.Fatalf("Backfill failed: %v", err)
	}

	fmt.Println("\nBackfill summary")
	fmt.Println("----------------")
	fmt.Printf("Scanned relationships:     %d\n", stats.scanned)
	fmt.Printf("Updated:                   %d\n", stats.updated)
	fmt.Printf("  via sender_id query:     %d\n", stats.matchedBySender)
	fmt.Printf("  via explorer scan:       %d\n", stats.matchedByScan)
	fmt.Printf("Already current:           %d\n", stats.skippedRecent)
	fmt.Printf("No reflections found:      %d\n", stats.noReflection)
	fmt.Printf("Write errors:              %d\n", stats.writeErrors)

	if len(stats.noReflectionDocs) > 0 {
		fmt.Println("\nRelationships with no matching reflections:")
		for _, line := range stats.noReflectionDocs {
			fmt.Printf(" - %s\n", line)
		}
	}
}

func backfillRelationships(
	ctx context.Context,
	client *firestore.Client,
	apply bool,
	explorerFilter string,
) (backfillStats, error) {
	stats := backfillStats{}
	iter := client.Collection(relationshipsCollection).Documents(ctx)
	defer iter.Stop()

	for {
		doc, err := iter.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return stats, fmt.Errorf("iterate relationships: %w", err)
		}

		stats.scanned++
		data := doc.Data()

		userID, _ := data["userId"].(string)
		relExplorerID, _ := data["explorerId"].(string)
		companionName, _ := data["companionName"].(string)
		if userID == "" || relExplorerID == "" {
			continue
		}
		if explorerFilter != "" && relExplorerID != explorerFilter {
			continue
		}

		match, err := latestReflectionMatch(ctx, client, userID, relExplorerID, companionName)
		if err != nil {
			return stats, err
		}
		if match.millis == 0 {
			stats.noReflection++
			if len(stats.noReflectionDocs) < 50 {
				stats.noReflectionDocs = append(
					stats.noReflectionDocs,
					fmt.Sprintf(
						"%s user=%s explorer=%s companion=%q",
						doc.Ref.ID,
						userID,
						relExplorerID,
						companionName,
					),
				)
			}
			continue
		}

		if match.viaSenderQuery {
			stats.matchedBySender++
		} else {
			stats.matchedByScan++
		}

		existingMillis := timestampMillis(data["lastReflectionSentAt"])
		if existingMillis == match.millis {
			stats.skippedRecent++
			continue
		}

		fmt.Printf(
			"%s relationship %s user=%s explorer=%s companion=%q -> lastReflectionSentAt=%s (%s)\n",
			modeLabel(apply),
			doc.Ref.ID,
			userID,
			relExplorerID,
			companionName,
			time.UnixMilli(match.millis).UTC().Format(time.RFC3339),
			match.matchReason,
		)

		if !apply {
			stats.updated++
			continue
		}

		_, err = doc.Ref.Update(ctx, []firestore.Update{
			{Path: "lastReflectionSentAt", Value: time.UnixMilli(match.millis).UTC()},
		})
		if err != nil {
			stats.writeErrors++
			fmt.Printf("  write error: %v\n", err)
			continue
		}
		stats.updated++
	}

	return stats, nil
}

type reflectionMatch struct {
	millis         int64
	viaSenderQuery bool
	matchReason    string
}

func latestReflectionMatch(
	ctx context.Context,
	client *firestore.Client,
	userID, explorerID, companionName string,
) (reflectionMatch, error) {
	latest, err := latestReflectionMillisFromSenderQuery(ctx, client, userID, explorerID)
	if err != nil {
		return reflectionMatch{}, err
	}
	if latest > 0 {
		return reflectionMatch{
			millis:         latest,
			viaSenderQuery: true,
			matchReason:    "sender_id query",
		}, nil
	}

	latest, reason, err := latestReflectionMillisFromExplorerScan(ctx, client, userID, explorerID, companionName)
	if err != nil {
		return reflectionMatch{}, err
	}
	if latest > 0 {
		return reflectionMatch{
			millis:      latest,
			matchReason: reason,
		}, nil
	}

	return reflectionMatch{}, nil
}

func latestReflectionMillisFromSenderQuery(
	ctx context.Context,
	client *firestore.Client,
	userID, explorerID string,
) (int64, error) {
	iter := client.Collection(reflectionsCollection).
		Where("explorerId", "==", explorerID).
		Where("sender_id", "==", userID).
		Documents(ctx)
	defer iter.Stop()

	return maxReflectionMillisFromIter(iter)
}

func latestReflectionMillisFromExplorerScan(
	ctx context.Context,
	client *firestore.Client,
	userID, explorerID, companionName string,
) (int64, string, error) {
	iter := client.Collection(reflectionsCollection).
		Where("explorerId", "==", explorerID).
		Documents(ctx)
	defer iter.Stop()

	companionKey := normalizeName(companionName)
	var latest int64
	matchReason := ""

	for {
		doc, err := iter.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return 0, "", fmt.Errorf("scan reflections for user=%s explorer=%s: %w", userID, explorerID, err)
		}

		data := doc.Data()
		if !reflectionBelongsToCompanion(data, userID, companionKey) {
			continue
		}

		millis := reflectionTimestampMillis(data)
		if millis > latest {
			latest = millis
			matchReason = reflectionMatchReason(data, userID, companionKey)
		}
	}

	return latest, matchReason, nil
}

func isCompanionReflectionType(reflectionType string) bool {
	if reflectionType == "" {
		return true
	}
	return reflectionType == "mirror_event" || reflectionType == "engagement_heartbeat"
}

func maxReflectionMillisFromIter(iter *firestore.DocumentIterator) (int64, error) {
	var latest int64
	for {
		doc, err := iter.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return 0, err
		}

		data := doc.Data()
		if reflectionType, _ := data["type"].(string); !isCompanionReflectionType(reflectionType) {
			continue
		}

		millis := reflectionTimestampMillis(data)
		if millis > latest {
			latest = millis
		}
	}

	return latest, nil
}

func reflectionBelongsToCompanion(data map[string]any, userID, companionKey string) bool {
	if reflectionType, _ := data["type"].(string); !isCompanionReflectionType(reflectionType) {
		return false
	}

	if senderID, _ := data["sender_id"].(string); senderID == userID {
		return true
	}

	if metadata, ok := data["metadata"].(map[string]any); ok {
		if senderID, _ := metadata["sender_id"].(string); senderID == userID {
			return true
		}
	}

	if companionKey != "" {
		if sender, _ := data["sender"].(string); normalizeName(sender) == companionKey {
			return true
		}
		if metadata, ok := data["metadata"].(map[string]any); ok {
			if sender, _ := metadata["sender"].(string); normalizeName(sender) == companionKey {
				return true
			}
		}
	}

	return false
}

func reflectionMatchReason(data map[string]any, userID, companionKey string) string {
	if senderID, _ := data["sender_id"].(string); senderID == userID {
		return "root sender_id"
	}
	if metadata, ok := data["metadata"].(map[string]any); ok {
		if senderID, _ := metadata["sender_id"].(string); senderID == userID {
			return "metadata.sender_id"
		}
	}
	if sender, _ := data["sender"].(string); normalizeName(sender) == companionKey {
		return "sender display name"
	}
	if metadata, ok := data["metadata"].(map[string]any); ok {
		if sender, _ := metadata["sender"].(string); normalizeName(sender) == companionKey {
			return "metadata.sender display name"
		}
	}
	return "explorer scan"
}

func reflectionTimestampMillis(data map[string]any) int64 {
	if metadata, ok := data["metadata"].(map[string]any); ok {
		if millis := timestampMillis(metadata["timestamp"]); millis > 0 {
			return millis
		}
		if millis := timestampMillis(metadata["last_edited_at"]); millis > 0 {
			return millis
		}
	}

	if millis := timestampMillis(data["timestamp"]); millis > 0 {
		return millis
	}

	return 0
}

func timestampMillis(value any) int64 {
	switch typed := value.(type) {
	case time.Time:
		return typed.UTC().UnixMilli()
	case *time.Time:
		if typed == nil {
			return 0
		}
		return typed.UTC().UnixMilli()
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return 0
		}
		if parsed, err := time.Parse(time.RFC3339Nano, trimmed); err == nil {
			return parsed.UTC().UnixMilli()
		}
		if parsed, err := time.Parse(time.RFC3339, trimmed); err == nil {
			return parsed.UTC().UnixMilli()
		}
		return 0
	default:
		return 0
	}
}

func normalizeName(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func modeLabel(apply bool) string {
	if apply {
		return "APPLY"
	}
	return "DRY-RUN"
}
