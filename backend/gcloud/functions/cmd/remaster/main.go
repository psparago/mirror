package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/google/generative-ai-go/genai"
	"google.golang.org/api/option"
	"mirror.local/functions"
)

var (
	BucketName = "mirror-uploads-sparago-2026"
	UserID     = getEnv("EXPLORER_ID", "cole")
	Region     = "us-east-1"
)

func getEnv(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok {
		return value
	}
	return fallback
}

func main() {
	// 1. Setup Environment
	apiKeyOpenAI := os.Getenv("OPENAI_API_KEY")
	if apiKeyOpenAI == "" {
		log.Fatal("❌ OPENAI_API_KEY is not set")
	}

	apiKeyGemini := os.Getenv("GEMINI_API_KEY")
	if apiKeyGemini == "" {
		log.Fatal("❌ GEMINI_API_KEY is not set")
	}

	ctx := context.Background()
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(Region))
	if err != nil {
		log.Fatalf("❌ AWS Config Error: %v", err)
	}

	s3Client := s3.NewFromConfig(cfg)

	// Setup Gemini
	genaiClient, err := genai.NewClient(ctx, option.WithAPIKey(apiKeyGemini))
	if err != nil {
		log.Fatalf("❌ Gemini Client Error: %v", err)
	}
	defer genaiClient.Close()
	model := genaiClient.GenerativeModel("gemini-2.5-flash-lite")

	// Wait between AI calls to stay under rate limits
	const AIDelay = 5 * time.Second
	fmt.Println("🚀 Starting Enhanced Audio & Metadata Remastering Backfill...")
	fmt.Printf("📂 Target: %s/to/ (UserID: %s)\n\n", BucketName, UserID)

	// 2. List all event folders
	prefix := fmt.Sprintf("%s/to/", UserID)
	input := &s3.ListObjectsV2Input{
		Bucket:    aws.String(BucketName),
		Prefix:    aws.String(prefix),
		Delimiter: aws.String("/"),
	}

	result, err := s3Client.ListObjectsV2(ctx, input)
	if err != nil {
		log.Fatalf("❌ S3 List Error: %v", err)
	}

	processedCount := 0
	errorCount := 0

	for _, commonPrefix := range result.CommonPrefixes {
		folder := *commonPrefix.Prefix
		parts := strings.Split(strings.TrimSuffix(folder, "/"), "/")
		eventID := parts[len(parts)-1]

		fmt.Printf("🔍 Processing Event: %s\n", eventID)

		// 3. Load metadata.json
		metaKey := folder + "metadata.json"
		var meta functions.EventMetadata

		metaObj, err := s3Client.GetObject(ctx, &s3.GetObjectInput{
			Bucket: aws.String(BucketName),
			Key:    aws.String(metaKey),
		})

		if err == nil {
			metaData, _ := io.ReadAll(metaObj.Body)
			json.Unmarshal(metaData, &meta)
		}

		// 4. Metadata Enrichment: If we are missing Description OR DeepDive, call Gemini
		if meta.Description == "" || meta.DeepDive == "" {
			fmt.Printf("   ✨ Calling AI to enrich metadata (missing fields)...\n")
			imageKey := folder + "image.jpg"
			imgObj, err := s3Client.GetObject(ctx, &s3.GetObjectInput{
				Bucket: aws.String(BucketName),
				Key:    aws.String(imageKey),
			})

			if err != nil {
				fmt.Printf("   ⚠️  Skip: image.jpg not found for event %s\n", eventID)
				continue
			}

			imgData, _ := io.ReadAll(imgObj.Body)
			explorerName := strings.Title(UserID)
			prompt := fmt.Sprintf("Analyze this image for a 15-year-old with Angelman Syndrome (%s). Return a SINGLE JSON object: {\"short_caption\": \"...\", \"deep_dive\": \"...\"}", explorerName)

			parts := []genai.Part{
				genai.ImageData("jpeg", imgData),
				genai.Text(prompt),
			}

			// Wait between AI calls to stay under rate limits
			time.Sleep(AIDelay)

			var resp *genai.GenerateContentResponse
			var genErr error

			// Simple retry logic for 429s (max 3 attempts)
			for attempt := 1; attempt <= 3; attempt++ {
				resp, genErr = model.GenerateContent(ctx, parts...)
				if genErr != nil && strings.Contains(genErr.Error(), "429") {
					fmt.Printf("   ⏳ Rate limit hit (Attempt %d/3). Waiting 60s...\n", attempt)
					time.Sleep(60 * time.Second)
					continue
				}
				break
			}

			if genErr != nil {
				fmt.Printf("   ❌ Gemini Error: %v\n", genErr)
				errorCount++
				continue
			}

			if len(resp.Candidates) > 0 && len(resp.Candidates[0].Content.Parts) > 0 {
				respText := fmt.Sprintf("%v", resp.Candidates[0].Content.Parts[0])
				jsonStr := strings.TrimSpace(respText)
				jsonStr = strings.TrimPrefix(jsonStr, "```json")
				jsonStr = strings.TrimPrefix(jsonStr, "```")
				jsonStr = strings.TrimSuffix(jsonStr, "```")
				jsonStr = strings.TrimSpace(jsonStr)

				var aiResult struct {
					ShortCaption string `json:"short_caption"`
					DeepDive     string `json:"deep_dive"`
				}

				if err := json.Unmarshal([]byte(jsonStr), &aiResult); err == nil {
					// Rule: Always preserve original description if it was already there (Companion recorded/typed)
					if meta.Description == "" {
						meta.Description = aiResult.ShortCaption
					}
					meta.DeepDive = aiResult.DeepDive
					meta.EventID = eventID
					if meta.Timestamp == "" {
						meta.Timestamp = time.Now().Format(time.RFC3339)
					}
					if meta.Sender == "" {
						meta.Sender = "Granddad"
					}

					// Write updated metadata.json back to S3
					newMetaData, _ := json.MarshalIndent(meta, "", "  ")
					err = functions.UploadToS3(ctx, metaKey, newMetaData, "application/json")
					if err != nil {
						fmt.Printf("   ❌ Error saving metadata: %v\n", err)
					} else {
						fmt.Printf("   ✅ Metadata enriched and saved\n")
					}
				} else {
					fmt.Printf("   ❌ Failed to parse AI JSON: %s\n", jsonStr)
				}
			}
		}

		// 5. Check & Generate Primary Caption Audio
		hasHumanAudio := functions.S3FileExists(ctx, s3Client, BucketName, folder+"audio.m4a") ||
			functions.S3FileExists(ctx, s3Client, BucketName, folder+"audio.mp3")

		hasAIAudio := functions.S3FileExists(ctx, s3Client, BucketName, folder+"audio_caption.mp3") ||
			functions.S3FileExists(ctx, s3Client, BucketName, folder+"caption.mp3")

		if !hasHumanAudio && !hasAIAudio && meta.Description != "" {
			fmt.Printf("   🎙️ Generating Primary Caption AI audio...\n")
			speechData, err := functions.GenerateSpeech(meta.Description)
			if err == nil {
				functions.UploadToS3(ctx, folder+"audio_caption.mp3", speechData, "audio/mpeg")
				fmt.Printf("   ✅ Saved: audio_caption.mp3\n")
				processedCount++
				time.Sleep(1 * time.Second)
			}
		}

		// 6. Check & Generate Deep Dive Audio
		hasDeepDiveAudio := functions.S3FileExists(ctx, s3Client, BucketName, folder+"deep_dive.m4a") ||
			functions.S3FileExists(ctx, s3Client, BucketName, folder+"deep_dive_audio.mp3")

		if !hasDeepDiveAudio && meta.DeepDive != "" {
			fmt.Printf("   🧠 Generating Deep Dive AI audio...\n")
			speechData, err := functions.GenerateSpeech(meta.DeepDive)
			if err == nil {
				functions.UploadToS3(ctx, folder+"deep_dive_audio.mp3", speechData, "audio/mpeg")
				fmt.Printf("   ✅ Saved: deep_dive_audio.mp3\n")
				processedCount++
				time.Sleep(1 * time.Second)
			}
		}
	}

	fmt.Printf("\n✨ Remastering Complete!\n")
	fmt.Printf("📊 Summary: Actions: %d, Errors: %d\n", processedCount, errorCount)
}
