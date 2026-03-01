package main

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"os"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	functions "mirror.local/functions"
)

const samplePhrase = "Sending Reflections is fun!"
const bucketName = "reflections-1200b-storage"

var voices = []string{
	"en-US-Journey-O",
	"en-US-Studio-O",
	"en-US-Neural2-C",
	"en-US-Journey-D",
	"en-US-Studio-Q",
	"en-US-Casual-K",
	"en-US-Chirp3-HD-Sulafat",
	"en-US-Chirp3-HD-Achernar",
	"en-US-Chirp3-HD-Despina",
}

func main() {
	ctx := context.Background()

	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion("us-east-1"))
	if err != nil {
		log.Fatalf("Failed to load AWS config: %v", err)
	}
	s3Client := s3.NewFromConfig(cfg)

	succeeded := 0
	for _, voice := range voices {
		fmt.Printf("Generating sample for %s...\n", voice)

		audioData, err := functions.GenerateSpeechWithOptions(samplePhrase, functions.SpeechOptions{
			VoiceName: voice,
		})
		if err != nil {
			log.Printf("  ERROR generating TTS for %s: %v\n", voice, err)
			continue
		}

		s3Key := fmt.Sprintf("assets/voice-samples/%s.mp3", voice)
		_, err = s3Client.PutObject(ctx, &s3.PutObjectInput{
			Bucket:      aws.String(bucketName),
			Key:         aws.String(s3Key),
			Body:        bytes.NewReader(audioData),
			ContentType: aws.String("audio/mpeg"),
		})
		if err != nil {
			log.Printf("  ERROR uploading %s to S3: %v\n", voice, err)
			continue
		}

		fmt.Printf("  ✅ Uploaded %s (%d bytes)\n", s3Key, len(audioData))
		succeeded++
	}

	fmt.Printf("\nDone: %d/%d voice samples generated and uploaded.\n", succeeded, len(voices))
	if succeeded < len(voices) {
		os.Exit(1)
	}
}
