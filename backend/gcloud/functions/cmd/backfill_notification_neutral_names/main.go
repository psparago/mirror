package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"

	"cloud.google.com/go/firestore"
	"google.golang.org/api/iterator"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	oldLikeTrigger = "cole_like"
	newLikeTrigger = "explorer_like"

	oldLikeDelayField = "cole_like_delay_seconds"
	newLikeDelayField = "explorer_like_delay_seconds"
)

type stats struct {
	systemConfigsScanned         int
	systemConfigsUpdated         int
	pendingNotificationsScanned  int
	pendingNotificationsUpdated  int
	pendingNotificationsRenamed  int
	pendingNotificationConflicts int
	writeErrors                  int
}

func main() {
	var (
		apply     bool
		projectID string
	)
	flag.BoolVar(&apply, "apply", false, "Write changes to Firestore (default is dry-run)")
	flag.StringVar(&projectID, "project", "", "GCP project ID (overrides GOOGLE_CLOUD_PROJECT/GCP_PROJECT)")
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
	fmt.Printf("Starting notification neutral-name backfill [%s] for project %s\n", mode, projectID)

	s := stats{}
	if err := migrateSystemConfig(ctx, client, apply, &s); err != nil {
		log.Fatalf("system_config migration failed: %v", err)
	}
	if err := migratePendingNotifications(ctx, client, apply, &s); err != nil {
		log.Fatalf("pending_notifications migration failed: %v", err)
	}

	fmt.Println("\nBackfill summary")
	fmt.Println("----------------")
	fmt.Printf("system_config scanned:              %d\n", s.systemConfigsScanned)
	fmt.Printf("system_config updated:              %d\n", s.systemConfigsUpdated)
	fmt.Printf("pending_notifications scanned:      %d\n", s.pendingNotificationsScanned)
	fmt.Printf("pending_notifications updated:      %d\n", s.pendingNotificationsUpdated)
	fmt.Printf("pending_notifications renamed:      %d\n", s.pendingNotificationsRenamed)
	fmt.Printf("pending_notifications conflicts:    %d\n", s.pendingNotificationConflicts)
	fmt.Printf("Write errors:                       %d\n", s.writeErrors)
}

func migrateSystemConfig(ctx context.Context, client *firestore.Client, apply bool, s *stats) error {
	iter := client.Collection("system_config").Documents(ctx)
	for {
		doc, err := iter.Next()
		if err == iterator.Done {
			return nil
		}
		if err != nil {
			return err
		}

		s.systemConfigsScanned++
		data := doc.Data()
		oldValue, hasOld := data[oldLikeDelayField]
		_, hasNew := data[newLikeDelayField]
		if !hasOld {
			continue
		}

		updates := []firestore.Update{
			{Path: oldLikeDelayField, Value: firestore.Delete},
		}
		if !hasNew {
			updates = append(updates, firestore.Update{Path: newLikeDelayField, Value: oldValue})
		}

		fmt.Printf("system_config/%s: %s -> %s\n", doc.Ref.ID, oldLikeDelayField, newLikeDelayField)
		if !apply {
			s.systemConfigsUpdated++
			continue
		}
		if _, err := doc.Ref.Update(ctx, updates); err != nil {
			s.writeErrors++
			fmt.Printf("  write failed: %v\n", err)
			continue
		}
		s.systemConfigsUpdated++
	}
}

func migratePendingNotifications(ctx context.Context, client *firestore.Client, apply bool, s *stats) error {
	iter := client.Collection("pending_notifications").Documents(ctx)
	for {
		doc, err := iter.Next()
		if err == iterator.Done {
			return nil
		}
		if err != nil {
			return err
		}

		s.pendingNotificationsScanned++
		data := doc.Data()
		triggerType, _ := data["triggerType"].(string)
		if triggerType != oldLikeTrigger {
			continue
		}

		data["triggerType"] = newLikeTrigger
		newID := neutralNotificationID(doc.Ref.ID)
		if newID == doc.Ref.ID {
			fmt.Printf("pending_notifications/%s: triggerType %s -> %s\n", doc.Ref.ID, oldLikeTrigger, newLikeTrigger)
			if !apply {
				s.pendingNotificationsUpdated++
				continue
			}
			if _, err := doc.Ref.Update(ctx, []firestore.Update{{Path: "triggerType", Value: newLikeTrigger}}); err != nil {
				s.writeErrors++
				fmt.Printf("  write failed: %v\n", err)
				continue
			}
			s.pendingNotificationsUpdated++
			continue
		}

		fmt.Printf("pending_notifications/%s -> pending_notifications/%s\n", doc.Ref.ID, newID)
		if !apply {
			s.pendingNotificationsRenamed++
			continue
		}

		renamed, conflict, err := renamePendingNotification(ctx, client, doc.Ref, newID, data)
		if err != nil {
			s.writeErrors++
			fmt.Printf("  write failed: %v\n", err)
			continue
		}
		if conflict {
			s.pendingNotificationConflicts++
			continue
		}
		if renamed {
			s.pendingNotificationsRenamed++
		}
	}
}

func neutralNotificationID(id string) string {
	if strings.HasPrefix(id, oldLikeTrigger+"_") {
		return newLikeTrigger + strings.TrimPrefix(id, oldLikeTrigger)
	}
	return id
}

func renamePendingNotification(ctx context.Context, client *firestore.Client, oldRef *firestore.DocumentRef, newID string, data map[string]any) (bool, bool, error) {
	newRef := oldRef.Parent.Doc(newID)
	err := client.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		newSnap, err := tx.Get(newRef)
		if err != nil && status.Code(err) != codes.NotFound {
			return err
		}
		if err == nil && newSnap.Exists() {
			return status.Errorf(codes.AlreadyExists, "target pending_notifications/%s already exists", newID)
		}
		if err := tx.Set(newRef, data); err != nil {
			return err
		}
		return tx.Delete(oldRef)
	})
	if status.Code(err) == codes.AlreadyExists {
		fmt.Printf("  conflict: target pending_notifications/%s already exists; source left unchanged\n", newID)
		return false, true, nil
	}
	if err != nil {
		return false, false, err
	}
	return true, false, nil
}
