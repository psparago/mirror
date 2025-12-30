package signer

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
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

	// 4. Presign the request
	// S3 structure: {userID}/from/{timestamp}.jpg
	// Ensure "mirror-uploads-sparago-2026" bucket exists in your target S3/Zenko!
	presignedRes, err := presignClient.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String("mirror-uploads-sparago-2026"),
		Key:    aws.String(fmt.Sprintf("%s/from/%d.jpg", UserID, time.Now().Unix())),
	})

	if err != nil {
		http.Error(w, "Presign Error: "+err.Error(), 500)
		return
	}

	// 5. Successful JSON response
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"url": presignedRes.URL,
	})
}

// ListMirrorPhotos handles listing the contents of the companion inbox
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
	input := &s3.ListObjectsV2Input{
		Bucket: aws.String("mirror-uploads-sparago-2026"),
		Prefix: aws.String(fmt.Sprintf("%s/to/", UserID)),
	}

	result, err := s3Client.ListObjectsV2(ctx, input)
	if err != nil {
		http.Error(w, "S3 List Error: "+err.Error(), 500)
		return
	}

	// 5. Generate presigned GET URLs for each object
	var presignedURLs []string
	folderPrefix := fmt.Sprintf("%s/to/", UserID)
	for _, obj := range result.Contents {
		// Skip the folder itself if it shows up in the list
		if *obj.Key != folderPrefix {
			// Generate presigned GET URL for this object
			presignedRes, err := presignClient.PresignGetObject(ctx, &s3.GetObjectInput{
				Bucket: aws.String("mirror-uploads-sparago-2026"),
				Key:    obj.Key,
			})
			if err != nil {
				// Log error but continue with other objects
				fmt.Printf("Error presigning %s: %v\n", *obj.Key, err)
				continue
			}
			presignedURLs = append(presignedURLs, presignedRes.URL)
		}
	}

	// 6. Return as JSON
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string][]string{
		"objects": presignedURLs,
	})
}
