package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"strings"

	"cloud.google.com/go/firestore"
	"google.golang.org/api/iterator"
)

func main() {
	var apply bool
	var projectID string
	flag.BoolVar(&apply, "apply", false, "Write explorerName to Firestore")
	flag.StringVar(&projectID, "project", "reflections-1200b", "GCP project")
	flag.Parse()

	ctx := context.Background()
	client, err := firestore.NewClient(ctx, projectID)
	if err != nil {
		log.Fatal(err)
	}
	defer client.Close()

	explorerNames := map[string]string{}
	mode := "DRY-RUN"
	if apply {
		mode = "APPLY"
	}
	fmt.Printf("Backfill relationship explorerName [%s]\n\n", mode)

	updated := 0
	skipped := 0
	iter := client.Collection("relationships").Documents(ctx)
	for {
		doc, err := iter.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			log.Fatal(err)
		}

		data := doc.Data()
		existing, _ := data["explorerName"].(string)
		if strings.TrimSpace(existing) != "" {
			skipped++
			continue
		}

		explorerID, _ := data["explorerId"].(string)
		if explorerID == "" {
			continue
		}

		name, ok := explorerNames[explorerID]
		if !ok {
			snap, err := client.Collection("explorers").Doc(explorerID).Get(ctx)
			if err != nil {
				fmt.Printf("skip %s: explorer %s not found (%v)\n", doc.Ref.ID, explorerID, err)
				continue
			}
			ed := snap.Data()
			name = strings.TrimSpace(fmt.Sprint(firstNonEmpty(
				ed["displayName"], ed["display_name"], ed["name"],
			)))
			if name == "" {
				name = explorerID
			}
			explorerNames[explorerID] = name
		}

		companion, _ := data["companionName"].(string)
		fmt.Printf("%s relationship %s companion=%q explorer=%s -> explorerName=%q\n",
			mode, doc.Ref.ID, companion, explorerID, name)

		if apply {
			if _, err := doc.Ref.Update(ctx, []firestore.Update{
				{Path: "explorerName", Value: name},
			}); err != nil {
				fmt.Printf("  write error: %v\n", err)
				continue
			}
		}
		updated++
	}

	fmt.Printf("\nUpdated: %d | Already had name: %d\n", updated, skipped)
}

func firstNonEmpty(values ...any) string {
	for _, v := range values {
		if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
	}
	return ""
}
