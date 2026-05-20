// One-shot backfill: reopen companion_upload pending_notifications that were
// incorrectly closed with skipped_cooldown before the companion ever received
// that upload in a digest.
//
// Dry run:
//   cd backend/gcloud/functions
//   go run ./cmd/backfill_zombie_upload_notifications/ -project reflections-1200b
//
// Apply:
//   go run ./cmd/backfill_zombie_upload_notifications/ -project reflections-1200b -apply
//
// After apply, redeploy aggregate-slow-lane-notifications (if not already) and
// wait for the next scheduler tick or invoke the function manually.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"sort"
	"strings"

	"cloud.google.com/go/firestore"
	"google.golang.org/api/iterator"
)

const (
	collectionName          = "pending_notifications"
	companionUploadTrigger  = "companion_upload"
	skippedCooldownStatus   = "skipped_cooldown"
)

type stats struct {
	scanned              int
	skippedNonUpload     int
	skippedNoRecipients  int
	needsRepair          int
	repaired             int
	cooldownEntriesRemoved int
	writeErrors          int
}

func main() {
	var (
		apply      bool
		projectID  string
		explorerID string
		docID      string
	)
	flag.BoolVar(&apply, "apply", false, "Write changes to Firestore (default is dry-run)")
	flag.StringVar(&projectID, "project", "", "GCP project ID (overrides GOOGLE_CLOUD_PROJECT/GCP_PROJECT)")
	flag.StringVar(&explorerID, "explorer", "", "Optional explorerId filter")
	flag.StringVar(&docID, "doc", "", "Optional pending_notifications document ID filter")
	flag.Parse()

	if projectID == "" {
		projectID = os.Getenv("GOOGLE_CLOUD_PROJECT")
	}
	if projectID == "" {
		projectID = os.Getenv("GCP_PROJECT")
	}
	if projectID == "" {
		log.Fatal("Missing project ID. Set GOOGLE_CLOUD_PROJECT/GCP_PROJECT or pass -project <id>.")
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
	fmt.Printf("Reopening zombie companion_upload notifications [%s] project=%s\n", mode, projectID)
	if explorerID != "" {
		fmt.Printf("Explorer filter: %s\n", explorerID)
	}
	if docID != "" {
		fmt.Printf("Document filter: %s\n", docID)
	}
	fmt.Println()

	s, examples, err := repairZombies(ctx, client, apply, explorerID, docID)
	if err != nil {
		log.Fatalf("Backfill failed: %v", err)
	}

	fmt.Println("\nSummary")
	fmt.Println("-------")
	fmt.Printf("pending_notifications scanned:     %d\n", s.scanned)
	fmt.Printf("skipped (not companion_upload):    %d\n", s.skippedNonUpload)
	fmt.Printf("skipped (no processedRecipients):  %d\n", s.skippedNoRecipients)
	fmt.Printf("documents needing repair:          %d\n", s.needsRepair)
	fmt.Printf("cooldown recipient entries removed:%d\n", s.cooldownEntriesRemoved)
	fmt.Printf("documents repaired:                %d\n", s.repaired)
	fmt.Printf("write errors:                      %d\n", s.writeErrors)

	if len(examples) > 0 {
		fmt.Println("\nExamples (doc -> companions reopened):")
		for _, line := range examples {
			fmt.Printf("  %s\n", line)
		}
	}

	if !apply && s.needsRepair > 0 {
		fmt.Println("\nRe-run with -apply to write changes.")
	}
}

func repairZombies(
	ctx context.Context,
	client *firestore.Client,
	apply bool,
	explorerFilter string,
	docFilter string,
) (stats, []string, error) {
	out := stats{}
	var examples []string

	var docs []*firestore.DocumentSnapshot

	if docFilter != "" {
		snap, err := client.Collection(collectionName).Doc(docFilter).Get(ctx)
		if err != nil {
			return out, examples, fmt.Errorf("get pending_notifications/%s: %w", docFilter, err)
		}
		docs = []*firestore.DocumentSnapshot{snap}
	} else {
		iter := client.Collection(collectionName).Documents(ctx)
		for {
			doc, err := iter.Next()
			if err == iterator.Done {
				break
			}
			if err != nil {
				return out, examples, err
			}
			docs = append(docs, doc)
		}
	}

	for _, doc := range docs {
		out.scanned++
		data := doc.Data()

		triggerType, _ := data["triggerType"].(string)
		if triggerType != companionUploadTrigger {
			out.skippedNonUpload++
			continue
		}

		if explorerFilter != "" {
			explorerID, _ := data["explorerId"].(string)
			if explorerID != explorerFilter {
				continue
			}
		}

		rawRecipients, ok := data["processedRecipients"].(map[string]interface{})
		if !ok || len(rawRecipients) == 0 {
			out.skippedNoRecipients++
			continue
		}

		cleaned, removedCompanionIDs := removeSkippedCooldownRecipients(rawRecipients)
		if len(removedCompanionIDs) == 0 {
			continue
		}

		out.needsRepair++
		out.cooldownEntriesRemoved += len(removedCompanionIDs)

		sort.Strings(removedCompanionIDs)
		reflectionID, _ := data["reflectionId"].(string)
		example := fmt.Sprintf(
			"%s reflectionId=%s reopened=%v remainingRecipients=%d",
			doc.Ref.ID,
			reflectionID,
			removedCompanionIDs,
			len(cleaned),
		)
		if len(examples) < 25 {
			examples = append(examples, example)
		}
		fmt.Println(example)

		if !apply {
			continue
		}

		updates := []firestore.Update{
			{Path: "status", Value: "pending"},
			{Path: "processedAt", Value: firestore.Delete},
			{Path: "processedRecipients", Value: cleaned},
		}
		if _, err := doc.Ref.Update(ctx, updates); err != nil {
			out.writeErrors++
			log.Printf("update failed for %s: %v", doc.Ref.ID, err)
			continue
		}
		out.repaired++
	}

	return out, examples, nil
}

func removeSkippedCooldownRecipients(
	raw map[string]interface{},
) (map[string]interface{}, []string) {
	cleaned := make(map[string]interface{}, len(raw))
	var removed []string

	for companionID, rawRecipient := range raw {
		recipient, ok := rawRecipient.(map[string]interface{})
		if !ok {
			cleaned[companionID] = rawRecipient
			continue
		}

		status, _ := recipient["status"].(string)
		if strings.TrimSpace(status) == skippedCooldownStatus {
			removed = append(removed, companionID)
			continue
		}

		cleaned[companionID] = recipient
	}

	return cleaned, removed
}
