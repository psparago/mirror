package functions

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"

	"cloud.google.com/go/compute/metadata"
	"cloud.google.com/go/firestore"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"google.golang.org/api/iterator"
)

const firestoreBatchLimit = 500

// reflectionEntry holds the Firestore doc ref plus the S3-relevant fields
// extracted at discovery time so we avoid a second round-trip per document.
type reflectionEntry struct {
	ref        *firestore.DocumentRef
	explorerID string
	eventID    string
}

// companionReflectionKeys returns the complete set of S3 object keys that must
// be removed for a single Reflection, mirroring the "to" path used by
// DeleteMirrorEvent in s3.go.
func companionReflectionKeys(explorerID, eventID string) []string {
	return []string{
		fmt.Sprintf("%s/to/%s/image.jpg", explorerID, eventID),
		fmt.Sprintf("%s/to/%s/image_original.jpg", explorerID, eventID),
		fmt.Sprintf("%s/to/%s/metadata.json", explorerID, eventID),
		fmt.Sprintf("%s/to/%s/audio.m4a", explorerID, eventID),
		fmt.Sprintf("%s/to/%s/deep_dive.m4a", explorerID, eventID),
		fmt.Sprintf("%s/to/%s/video.mp4", explorerID, eventID),
		fmt.Sprintf("%s/to/%s/video_original.mp4", explorerID, eventID),
		fmt.Sprintf("%s/to/%s/video.mov", explorerID, eventID),
	}
}

// collectReflections streams a Firestore DocumentIterator into reflectionEntry
// values, deduplicating by document ID via the seenIDs set.
func collectReflections(iter *firestore.DocumentIterator, seenIDs map[string]struct{}) ([]reflectionEntry, error) {
	var entries []reflectionEntry
	for {
		doc, err := iter.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return nil, err
		}
		if _, exists := seenIDs[doc.Ref.ID]; exists {
			continue
		}
		seenIDs[doc.Ref.ID] = struct{}{}
		data := doc.Data()
		explorerID, _ := data["explorerId"].(string)
		eventID, _ := data["event_id"].(string)
		entries = append(entries, reflectionEntry{
			ref:        doc.Ref,
			explorerID: explorerID,
			eventID:    eventID,
		})
	}
	return entries, nil
}

// commitBatches deletes all supplied document refs using one or more Firestore
// WriteBatches, chunked to respect the 500-operation limit per batch.
func commitBatches(ctx context.Context, fsClient *firestore.Client, refs []*firestore.DocumentRef) error {
	batch := fsClient.Batch()
	count := 0
	for _, ref := range refs {
		batch.Delete(ref)
		count++
		if count == firestoreBatchLimit {
			if _, err := batch.Commit(ctx); err != nil {
				return err
			}
			batch = fsClient.Batch()
			count = 0
		}
	}
	if count > 0 {
		if _, err := batch.Commit(ctx); err != nil {
			return err
		}
	}
	return nil
}

// CleanupCompanionData purges all data owned by a companion before their
// Firebase Auth record is deleted. It performs three sequential phases:
//
//  1. Discover every Reflection document sent by userID.
//  2. Delete the corresponding S3 media objects.
//  3. Atomically delete (in chunked batches) all Reflection docs, all
//     relationship docs, and the user's profile document from Firestore.
//
// Any failure returns a descriptive error so the caller knows not to proceed
// with the Auth deletion.
func CleanupCompanionData(ctx context.Context, userID string) error {
	// --- AWS / S3 client -----------------------------------------------
	awsCfg, err := config.LoadDefaultConfig(ctx, config.WithRegion("us-east-1"))
	if err != nil {
		return fmt.Errorf("CleanupCompanionData: AWS config: %w", err)
	}
	s3Client := s3.NewFromConfig(awsCfg)

	// --- Firestore client ---------------------------------------------
	// Resolve project ID: env vars first (local/CI), then GCP metadata server
	// (always available on Cloud Functions Gen2 / Cloud Run at runtime).
	projectID := os.Getenv("GCP_PROJECT")
	if projectID == "" {
		projectID = os.Getenv("GOOGLE_CLOUD_PROJECT")
	}
	if projectID == "" {
		projectID, err = metadata.ProjectID()
		if err != nil {
			return fmt.Errorf("CleanupCompanionData: could not determine GCP project ID: %w", err)
		}
	}
	fsClient, err := firestore.NewClient(ctx, projectID)
	if err != nil {
		return fmt.Errorf("CleanupCompanionData: Firestore client: %w", err)
	}
	defer fsClient.Close()

	// ------------------------------------------------------------------
	// Phase 1 — Discover Reflection documents belonging to this companion.
	// ------------------------------------------------------------------
	seenIDs := map[string]struct{}{}

	// Primary query: root-level sender_id (all new + backfilled docs).
	primary, err := collectReflections(
		fsClient.Collection("reflections").Where("sender_id", "==", userID).Documents(ctx),
		seenIDs,
	)
	if err != nil {
		return fmt.Errorf("CleanupCompanionData: reflections query (sender_id): %w", err)
	}

	// Defensive fallback: older docs may only carry metadata.sender_id.
	fallback, err := collectReflections(
		fsClient.Collection("reflections").Where("metadata.sender_id", "==", userID).Documents(ctx),
		seenIDs,
	)
	if err != nil {
		return fmt.Errorf("CleanupCompanionData: reflections query (metadata.sender_id): %w", err)
	}

	reflections := append(primary, fallback...)
	fmt.Printf("CleanupCompanionData: found %d reflection(s) for user %s\n", len(reflections), userID)

	// ------------------------------------------------------------------
	// Phase 2 — Delete S3 media for each discovered Reflection.
	// ------------------------------------------------------------------
	for _, r := range reflections {
		if r.explorerID == "" || r.eventID == "" {
			// Skip malformed docs; S3 keys cannot be safely constructed.
			fmt.Printf("CleanupCompanionData: skipping doc %s (missing explorerId or event_id)\n", r.ref.ID)
			continue
		}
		for _, key := range companionReflectionKeys(r.explorerID, r.eventID) {
			if _, err := s3Client.DeleteObject(ctx, &s3.DeleteObjectInput{
				Bucket: aws.String("reflections-1200b-storage"),
				Key:    aws.String(key),
			}); err != nil {
				return fmt.Errorf("CleanupCompanionData: S3 delete %q: %w", key, err)
			}
		}
	}

	// ------------------------------------------------------------------
	// Phase 3 — Discover relationship documents for this companion.
	// ------------------------------------------------------------------
	var relationshipRefs []*firestore.DocumentRef
	relIter := fsClient.Collection("relationships").Where("userId", "==", userID).Documents(ctx)
	for {
		doc, err := relIter.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return fmt.Errorf("CleanupCompanionData: relationships query: %w", err)
		}
		relationshipRefs = append(relationshipRefs, doc.Ref)
	}
	fmt.Printf("CleanupCompanionData: found %d relationship(s) for user %s\n", len(relationshipRefs), userID)

	// ------------------------------------------------------------------
	// Phase 4 — Atomic Firestore batch deletion (chunked ≤ 500 ops).
	// Deletes: all Reflection docs + all relationship docs + users/{userID}.
	// ------------------------------------------------------------------
	var allRefs []*firestore.DocumentRef
	for _, r := range reflections {
		allRefs = append(allRefs, r.ref)
	}
	allRefs = append(allRefs, relationshipRefs...)
	allRefs = append(allRefs, fsClient.Collection("users").Doc(userID))

	if err := commitBatches(ctx, fsClient, allRefs); err != nil {
		return fmt.Errorf("CleanupCompanionData: Firestore batch delete: %w", err)
	}

	fmt.Printf("CleanupCompanionData: successfully purged data for user %s\n", userID)
	return nil
}

// DeleteCompanionAccount is the HTTP Cloud Function entry point that wraps
// CleanupCompanionData. The Connect app calls this before deleting the
// Firebase Auth record; a non-200 response signals that cleanup failed and
// Auth deletion must be aborted.
func DeleteCompanionAccount(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	if r.Method == http.MethodOptions {
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var body struct {
		UserID string `json:"user_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.UserID == "" {
		http.Error(w, "user_id is required in the JSON body", http.StatusBadRequest)
		return
	}

	if err := CleanupCompanionData(r.Context(), body.UserID); err != nil {
		fmt.Printf("DeleteCompanionAccount: cleanup failed for user %s: %v\n", body.UserID, err)
		http.Error(w, "cleanup failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
