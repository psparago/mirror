package main

import (
	"context"
	"fmt"
	"log"
	"os"

	"github.com/google/generative-ai-go/genai"
	"google.golang.org/api/option"
)

func main() {
	ctx := context.Background()
	apiKey := os.Getenv("GEMINI_API_KEY")
	client, err := genai.NewClient(ctx, option.WithAPIKey(apiKey))
	if err != nil {
		log.Fatal(err)
	}
	defer client.Close()

	model := client.GenerativeModel("gemini-2.5-flash-lite")
	// Just a dummy text request to check quota
	resp, err := model.GenerateContent(ctx, genai.Text("Hello"))
	if err != nil {
		log.Fatalf("❌ Quota Error: %v", err)
	}
	fmt.Printf("✅ Success! Response: %v\n", resp.Candidates[0].Content.Parts[0])
}
