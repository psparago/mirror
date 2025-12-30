package signer

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type Response struct {
	URL string `json:"url"`
}

// UserID represents the current user - eventually this will come from Firebase
// For now, hardcoded as "cole" but can be made configurable via query parameter or auth token
const UserID = "cole"

func GetSignedURL(w http.ResponseWriter, r *http.Request) {
	// 1. CORS Headers
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == "OPTIONS" {
		return
	}

	ctx := context.TODO()

	// 2. Load Config with absolute error checking
	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion("us-east-1"), // AWS SDK requires a region even for custom endpoints
	)
	if err != nil {
		http.Error(w, "AWS Config Error: "+err.Error(), 500)
		return
	}

	// 3. Initialize Client safely
	s3Client := s3.NewFromConfig(cfg)
	presignClient := s3.NewPresignClient(s3Client)

	// 4. Determine upload path: "to" (companion -> cole) or "from" (cole -> companion)
	// Default to "from" for Cole's responses, "to" for companion uploads
	path := r.URL.Query().Get("path")
	if path != "to" && path != "from" {
		path = "from" // Default to Cole's responses
	}

	// 5. Check if this is an event bundle upload (new structure)
	eventID := r.URL.Query().Get("event_id")
	filename := r.URL.Query().Get("filename") // "image.jpg" or "metadata.json"

	var s3Key string
	if eventID != "" && filename != "" {
		// Event bundle structure: {userID}/{path}/{event_id}/{filename}
		s3Key = fmt.Sprintf("%s/%s/%s/%s", UserID, path, eventID, filename)
	} else {
		// Legacy single photo structure: {userID}/{path}/{timestamp}.jpg
		s3Key = fmt.Sprintf("%s/%s/%d.jpg", UserID, path, time.Now().Unix())
	}

	// 6. Presign the request
	// Ensure "mirror-uploads-sparago-2026" bucket exists in your target S3/Zenko!
	presignedRes, err := presignClient.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String("mirror-uploads-sparago-2026"),
		Key:    aws.String(s3Key),
	})

	if err != nil {
		http.Error(w, "Presign Error: "+err.Error(), 500)
		return
	}

	// 7. Successful JSON response
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"url": presignedRes.URL,
	})
}

// EventMetadata represents the structure of metadata.json
type EventMetadata struct {
	Description string `json:"description"`
	Sender      string `json:"sender"`
	Timestamp   string `json:"timestamp"`
	EventID     string `json:"event_id"`
}

// Event represents a complete event bundle
type Event struct {
	EventID     string         `json:"event_id"`
	ImageURL    string         `json:"image_url"`
	MetadataURL string         `json:"metadata_url"`
	Metadata    *EventMetadata `json:"metadata,omitempty"`
}

// ListMirrorPhotos handles listing event bundles in Cole's inbox
func ListMirrorPhotos(w http.ResponseWriter, r *http.Request) {
	// 1. Standard CORS
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	if r.Method == "OPTIONS" {
		return
	}

	ctx := context.TODO()

	// 2. Load Config with region
	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion("us-east-1"),
	)
	if err != nil {
		http.Error(w, "AWS Config Error: "+err.Error(), 500)
		return
	}

	// 3. Initialize Client and Presign Client
	s3Client := s3.NewFromConfig(cfg)
	presignClient := s3.NewPresignClient(s3Client)

	// 4. List objects in the "{userID}/to/" prefix (Cole's inbox)
	// Don't use delimiter - we need to see all nested objects
	input := &s3.ListObjectsV2Input{
		Bucket: aws.String("mirror-uploads-sparago-2026"),
		Prefix: aws.String(fmt.Sprintf("%s/to/", UserID)),
	}

	result, err := s3Client.ListObjectsV2(ctx, input)
	if err != nil {
		http.Error(w, "S3 List Error: "+err.Error(), 500)
		return
	}

	// 5. Organize events by folder (event_id)
	eventMap := make(map[string]*Event)
	folderPrefix := fmt.Sprintf("%s/to/", UserID)

	// Process all objects to find image.jpg and metadata.json files
	// (No need to process CommonPrefixes since we removed the delimiter)
	for _, obj := range result.Contents {
		key := *obj.Key
		// Skip the folder itself
		if key == folderPrefix {
			continue
		}

		// Extract event_id and filename from path like "cole/to/{event_id}/image.jpg"
		relativePath := key[len(folderPrefix):]
		parts := strings.Split(relativePath, "/")

		// Should have exactly 2 parts: [event_id, filename]
		if len(parts) == 2 {
			eventID := parts[0]
			filename := parts[1]

			// Ensure event exists in map
			if _, exists := eventMap[eventID]; !exists {
				eventMap[eventID] = &Event{
					EventID: eventID,
				}
			}

			// Generate presigned GET URL
			presignedRes, err := presignClient.PresignGetObject(ctx, &s3.GetObjectInput{
				Bucket: aws.String("mirror-uploads-sparago-2026"),
				Key:    aws.String(key),
			})
			if err != nil {
				fmt.Printf("Error presigning %s: %v\n", key, err)
				continue
			}

			// Assign URL based on filename
			if filename == "image.jpg" {
				eventMap[eventID].ImageURL = presignedRes.URL
				fmt.Printf("Found image for event %s\n", eventID)
			} else if filename == "metadata.json" {
				eventMap[eventID].MetadataURL = presignedRes.URL
				fmt.Printf("Found metadata for event %s\n", eventID)
			}
		} else {
			// Log unexpected path structure for debugging
			fmt.Printf("Unexpected path structure: %s (parts: %v)\n", key, parts)
		}
	}

	// 6. Convert map to slice and fetch metadata for each event
	var events []Event
	for _, event := range eventMap {
		// Fetch metadata if URL exists
		if event.MetadataURL != "" {
			// Extract the S3 key from the presigned URL to fetch metadata
			// For now, we'll return the metadata URL and let the frontend fetch it
			// This keeps the response size manageable
		}
		events = append(events, *event)
	}

	// 7. Return as JSON
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"events": events,
	})
}
