package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"

	"cloud.google.com/go/firestore"
	"google.golang.org/api/iterator"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type stats struct {
	usersScanned               int
	usersUpdated               int
	explorersScanned           int
	systemConfigsCreated       int
	systemConfigsExisting      int
	reflectionsScanned         int
	reflectionsLikeMigrated    int
	reflectionsMissingExplorer int
	writeErrors                int
}

func main() {
	var (
		apply     bool
		projectID string
	)
	flag.BoolVar(&apply, "apply", false, "Write changes to Firestore (default is dry-run)")
	flag.StringVar(&projectID, "project", "", "GCP project ID (overrides GOOGLE_CLOUD_PROJECT)")
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
	fmt.Printf("Starting notification defaults backfill [%s] for project %s\n", mode, projectID)

	explorerDevices, s, err := loadExplorerDevicesAndBackfillConfig(ctx, client, apply)
	if err != nil {
		log.Fatalf("Explorer/system_config backfill failed: %v", err)
	}
	if err := backfillUsers(ctx, client, apply, &s); err != nil {
		log.Fatalf("User backfill failed: %v", err)
	}
	if err := migrateHistoricalLikes(ctx, client, explorerDevices, apply, &s); err != nil {
		log.Fatalf("Historical like migration failed: %v", err)
	}

	fmt.Println("\nBackfill summary")
	fmt.Println("----------------")
	fmt.Printf("Users scanned:                    %d\n", s.usersScanned)
	fmt.Printf("Users updated:                    %d\n", s.usersUpdated)
	fmt.Printf("Explorers scanned:                %d\n", s.explorersScanned)
	fmt.Printf("system_config created:            %d\n", s.systemConfigsCreated)
	fmt.Printf("system_config already existed:    %d\n", s.systemConfigsExisting)
	fmt.Printf("Reflections scanned:              %d\n", s.reflectionsScanned)
	fmt.Printf("Reflection likedBy arrays updated:%d\n", s.reflectionsLikeMigrated)
	fmt.Printf("Reflections missing explorerId:   %d\n", s.reflectionsMissingExplorer)
	fmt.Printf("Write errors:                     %d\n", s.writeErrors)
}

func backfillUsers(ctx context.Context, client *firestore.Client, apply bool, s *stats) error {
	iter := client.Collection("users").Documents(ctx)
	for {
		doc, err := iter.Next()
		if err == iterator.Done {
			return nil
		}
		if err != nil {
			return err
		}

		s.usersScanned++
		data := doc.Data()
		if _, exists := data["push_notifications_enabled"]; exists {
			continue
		}
		fmt.Printf("users/%s missing push_notifications_enabled; setting true\n", doc.Ref.ID)
		if !apply {
			s.usersUpdated++
			continue
		}
		if _, err := doc.Ref.Update(ctx, []firestore.Update{
			{Path: "push_notifications_enabled", Value: true},
		}); err != nil {
			s.writeErrors++
			fmt.Printf("  write failed: %v\n", err)
			continue
		}
		s.usersUpdated++
	}
}

func loadExplorerDevicesAndBackfillConfig(ctx context.Context, client *firestore.Client, apply bool) (map[string]map[string]struct{}, stats, error) {
	explorerDevices := map[string]map[string]struct{}{}
	s := stats{}

	iter := client.Collection("explorers").Documents(ctx)
	for {
		doc, err := iter.Next()
		if err == iterator.Done {
			return explorerDevices, s, nil
		}
		if err != nil {
			return nil, s, err
		}

		s.explorersScanned++
		explorerID := doc.Ref.ID
		explorerDevices[explorerID] = authorizedDeviceSet(doc.Data()["authorizedDevices"])

		configRef := client.Collection("system_config").Doc(explorerID)
		configSnap, err := configRef.Get(ctx)
		if err == nil && configSnap.Exists() {
			s.systemConfigsExisting++
			continue
		}
		if err != nil && status.Code(err) != codes.NotFound {
			return nil, s, fmt.Errorf("get system_config/%s: %w", explorerID, err)
		}

		fmt.Printf("system_config/%s missing; creating defaults\n", explorerID)
		if !apply {
			s.systemConfigsCreated++
			continue
		}
		_, err = configRef.Create(ctx, map[string]any{
			"debounce_minutes":          15,
			"min_hours_between_digests": 4,
			"cole_like_delay_seconds":   60,
		})
		if status.Code(err) == codes.AlreadyExists {
			s.systemConfigsExisting++
			continue
		}
		if err != nil {
			s.writeErrors++
			fmt.Printf("  write failed: %v\n", err)
			continue
		}
		s.systemConfigsCreated++
	}
}

func authorizedDeviceSet(value any) map[string]struct{} {
	out := map[string]struct{}{}
	values, ok := value.([]any)
	if !ok {
		return out
	}
	for _, value := range values {
		id, ok := value.(string)
		if ok && id != "" {
			out[id] = struct{}{}
		}
	}
	return out
}

func migrateHistoricalLikes(ctx context.Context, client *firestore.Client, explorerDevices map[string]map[string]struct{}, apply bool, s *stats) error {
	iter := client.Collection("reflections").Documents(ctx)
	for {
		doc, err := iter.Next()
		if err == iterator.Done {
			return nil
		}
		if err != nil {
			return err
		}

		s.reflectionsScanned++
		data := doc.Data()
		explorerID, _ := data["explorerId"].(string)
		if explorerID == "" {
			s.reflectionsMissingExplorer++
			continue
		}

		likes, ok := stringSlice(data["likedBy"])
		if !ok || len(likes) == 0 {
			continue
		}
		devices := explorerDevices[explorerID]
		if len(devices) == 0 {
			continue
		}

		migrated := migrateLikeIDs(likes, explorerID, devices)
		if stringSlicesEqual(likes, migrated) {
			continue
		}

		fmt.Printf("reflections/%s likedBy: %v -> %v\n", doc.Ref.ID, likes, migrated)
		if !apply {
			s.reflectionsLikeMigrated++
			continue
		}
		if _, err := doc.Ref.Update(ctx, []firestore.Update{
			{Path: "likedBy", Value: migrated},
		}); err != nil {
			s.writeErrors++
			fmt.Printf("  write failed: %v\n", err)
			continue
		}
		s.reflectionsLikeMigrated++
	}
}

func stringSlice(value any) ([]string, bool) {
	values, ok := value.([]any)
	if !ok {
		return nil, false
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		s, ok := value.(string)
		if ok {
			out = append(out, s)
		}
	}
	return out, true
}

func migrateLikeIDs(likes []string, explorerID string, devices map[string]struct{}) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(likes))

	for _, likeID := range likes {
		nextID := likeID
		if _, isExplorerDevice := devices[likeID]; isExplorerDevice {
			nextID = explorerID
		}
		if nextID == "" {
			continue
		}
		if _, exists := seen[nextID]; exists {
			continue
		}
		seen[nextID] = struct{}{}
		out = append(out, nextID)
	}
	return out
}

func stringSlicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
