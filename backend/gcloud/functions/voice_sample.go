package functions

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

const voiceSampleBucket = "reflections-1200b-storage"

// GetVoiceSample returns a presigned GET URL for a voice preview MP3 stored in S3.
// Query parameter: ?voice=en-US-Journey-O
func GetVoiceSample(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	if r.Method == "OPTIONS" {
		return
	}

	voice := r.URL.Query().Get("voice")
	if _, ok := allowedGoogleTTSVoices[voice]; !ok {
		http.Error(w, "invalid or missing voice parameter", 400)
		return
	}

	ctx := context.Background()
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion("us-east-1"))
	if err != nil {
		http.Error(w, "aws config error: "+err.Error(), 500)
		return
	}

	presignClient := s3.NewPresignClient(s3.NewFromConfig(cfg))
	s3Key := "assets/voice-samples/" + voice + ".mp3"

	presigned, err := presignClient.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(voiceSampleBucket),
		Key:    aws.String(s3Key),
	}, s3.WithPresignExpires(15*time.Minute))
	if err != nil {
		http.Error(w, "failed to presign: "+err.Error(), 500)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"url": presigned.URL})
}
