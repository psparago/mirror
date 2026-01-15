package main

import (
	"context"
	"fmt"
	"log"
	"os"

	"cloud.google.com/go/firestore"
	"google.golang.org/api/iterator"
)

func main() {
	projectID := os.Getenv("GOOGLE_CLOUD_PROJECT")
	if projectID == "" {
		projectID = "project-mirror-23168" // Fallback project ID
	}

	ctx := context.Background()

	// Initialize Firestore client
	// This assumes GOOGLE_APPLICATION_CREDENTIALS is set or running in an authorized environment
	client, err := firestore.NewClient(ctx, projectID)
	if err != nil {
		log.Fatalf("Failed to create firestore client: %v", err)
	}
	defer client.Close()

	fmt.Printf("🚀 Starting Multi-Explorer Migration for Project: %s\n", projectID)
	fmt.Println("==========================================================")

	// 1. Migrate 'signals' to 'reflections'
	fmt.Println("📋 Migrating 'signals' to 'reflections'...")
	migrateCollection(ctx, client, "signals", "reflections", "cole")

	// 2. Migrate 'reflection_responses' to 'responses'
	fmt.Println("\n📋 Migrating 'reflection_responses' to 'responses'...")
	migrateCollection(ctx, client, "reflection_responses", "responses", "cole")

	fmt.Println("\n✨ Migration Complete!")
}

func migrateCollection(ctx context.Context, client *firestore.Client, sourceColl, destColl, explorerID string) {
	iter := client.Collection(sourceColl).Documents(ctx)
	count := 0
	errorCount := 0

	for {
		doc, err := iter.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			fmt.Printf("   ❌ Error reading doc: %v\n", err)
			errorCount++
			continue
		}

		data := doc.Data()

		// Add explorerId if it doesn't exist
		if _, exists := data["explorerId"]; !exists {
			data["explorerId"] = explorerID
		}

		// Map signalId to event_id if it's a signals collection migration and event_id is missing
		// Though usually event_id is already there.
		if sourceColl == "signals" {
			if _, exists := data["event_id"]; !exists {
				data["event_id"] = doc.Ref.ID
			}
		}

		// Write to new collection
		_, err = client.Collection(destColl).Doc(doc.Ref.ID).Set(ctx, data)
		if err != nil {
			fmt.Printf("   ❌ Error writing doc %s: %v\n", doc.Ref.ID, err)
			errorCount++
		} else {
			fmt.Printf("   ✅ Migrated doc: %s\n", doc.Ref.ID)
			count++
		}
	}

	fmt.Printf("📊 Summary for %s -> %s: Migrated: %d, Errors: %d\n", sourceColl, destColl, count, errorCount)
}
