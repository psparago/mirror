package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"sort"
	"strings"

	"cloud.google.com/go/firestore"
	"google.golang.org/api/iterator"
)

type relationship struct {
	explorerID    string
	userID        string
	companionName string
}

func main() {
	var (
		apply      bool
		explorerID string
		projectID  string
		aliasesArg string
	)

	flag.BoolVar(&apply, "apply", false, "Write sender_id values to Firestore (default is dry-run)")
	flag.StringVar(&explorerID, "explorer", "", "Optional explorerId filter (e.g. PETER-08271957)")
	flag.StringVar(&projectID, "project", "", "GCP project ID (overrides GOOGLE_CLOUD_PROJECT)")
	flag.StringVar(&aliasesArg, "aliases", "", "Optional sender aliases: old=new,old2=new2")
	flag.Parse()

	if projectID == "" {
		projectID = os.Getenv("GOOGLE_CLOUD_PROJECT")
	}
	if projectID == "" {
		log.Fatal("Missing project ID. Set GOOGLE_CLOUD_PROJECT or pass -project <id>.")
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
	fmt.Printf("Starting sender_id backfill [%s] for project %s\n", mode, projectID)
	if explorerID != "" {
		fmt.Printf("Explorer filter: %s\n", explorerID)
	}
	aliases := parseAliases(aliasesArg)
	if len(aliases) > 0 {
		fmt.Printf("Alias mappings loaded: %d\n", len(aliases))
	}

	nameIndex, relCount, err := loadRelationshipIndex(ctx, client, explorerID)
	if err != nil {
		log.Fatalf("Failed loading relationships: %v", err)
	}
	fmt.Printf("Loaded %d relationship rows across %d explorer(s)\n", relCount, len(nameIndex))
	if relCount == 0 {
		fmt.Println("⚠️  No relationships found. This usually means wrong project/account or unexpected field shape.")
	}

	stats, err := backfillReflections(ctx, client, nameIndex, explorerID, aliases, apply)
	if err != nil {
		log.Fatalf("Backfill failed: %v", err)
	}

	fmt.Println("\nBackfill summary")
	fmt.Println("---------------")
	fmt.Printf("Scanned (all reflections):   %d\n", stats.scannedTotal)
	fmt.Printf("Scanned (target explorer):   %d\n", stats.scannedTarget)
	fmt.Printf("Skipped by explorer filter:  %d\n", stats.skippedByExplorer)
	fmt.Printf("Already had sender_id: %d\n", stats.alreadySet)
	fmt.Printf("Updated:             %d\n", stats.updated)
	fmt.Printf("Updated via fallback (single relationship): %d\n", stats.fallbackUsed)
	fmt.Printf("Missing explorerId:  %d\n", stats.missingExplorer)
	fmt.Printf("Missing sender:      %d\n", stats.missingSender)
	fmt.Printf("No relationship match: %d\n", stats.noMatch)
	fmt.Printf("Ambiguous matches:   %d\n", stats.ambiguous)
	fmt.Printf("Write errors:        %d\n", stats.writeErrors)

	if len(stats.ambiguousExamples) > 0 {
		fmt.Println("\nAmbiguous examples (manual review needed):")
		sort.Strings(stats.ambiguousExamples)
		for _, line := range stats.ambiguousExamples {
			fmt.Printf(" - %s\n", line)
		}
	}

	if len(stats.noMatchSenderNames) > 0 {
		fmt.Println("\nNo-match sender names (top):")
		type kv struct {
			name  string
			count int
		}
		var rows []kv
		for name, count := range stats.noMatchSenderNames {
			rows = append(rows, kv{name: name, count: count})
		}
		sort.Slice(rows, func(i, j int) bool {
			if rows[i].count == rows[j].count {
				return rows[i].name < rows[j].name
			}
			return rows[i].count > rows[j].count
		})
		limit := 10
		if len(rows) < limit {
			limit = len(rows)
		}
		for i := 0; i < limit; i++ {
			fmt.Printf(" - %q: %d\n", rows[i].name, rows[i].count)
		}
	}

	if len(stats.missingSenderDocs) > 0 {
		fmt.Println("\nMissing sender docs (manual patch needed):")
		sort.Strings(stats.missingSenderDocs)
		for _, docID := range stats.missingSenderDocs {
			fmt.Printf(" - reflections/%s\n", docID)
		}
	}

	if len(stats.missingExplorerDocs) > 0 {
		fmt.Println("\nMissing explorerId docs:")
		sort.Strings(stats.missingExplorerDocs)
		for _, docID := range stats.missingExplorerDocs {
			fmt.Printf(" - reflections/%s\n", docID)
		}
	}
}

func normalizeName(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

func parseAliases(raw string) map[string]string {
	out := map[string]string{}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return out
	}
	pairs := strings.Split(raw, ",")
	for _, p := range pairs {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		parts := strings.SplitN(p, "=", 2)
		if len(parts) != 2 {
			log.Fatalf("Invalid alias format %q. Expected old=new", p)
		}
		from := normalizeName(parts[0])
		to := normalizeName(parts[1])
		if from == "" || to == "" {
			log.Fatalf("Invalid alias mapping %q. Both sides must be non-empty.", p)
		}
		out[from] = to
	}
	return out
}

func loadRelationshipIndex(ctx context.Context, client *firestore.Client, explorerFilter string) (map[string]map[string][]string, int, error) {
	index := make(map[string]map[string][]string)
	total := 0

	iter := client.Collection("relationships").Documents(ctx)
	for {
		doc, err := iter.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return nil, 0, err
		}

		data := doc.Data()
		explorerID, _ := data["explorerId"].(string)
		userID, _ := data["userId"].(string)
		companionName, _ := data["companionName"].(string)
		if explorerID == "" || userID == "" || companionName == "" {
			continue
		}
		if explorerFilter != "" && explorerID != explorerFilter {
			continue
		}

		key := normalizeName(companionName)
		if key == "" {
			continue
		}

		if _, ok := index[explorerID]; !ok {
			index[explorerID] = make(map[string][]string)
		}
		index[explorerID][key] = append(index[explorerID][key], userID)
		total++
	}

	return index, total, nil
}

type summary struct {
	scannedTotal       int
	scannedTarget      int
	skippedByExplorer  int
	alreadySet         int
	updated            int
	fallbackUsed       int
	missingExplorer    int
	missingSender      int
	noMatch            int
	ambiguous          int
	writeErrors        int
	ambiguousExamples  []string
	missingSenderDocs  []string
	missingExplorerDocs []string
	noMatchSenderNames map[string]int
}

func backfillReflections(
	ctx context.Context,
	client *firestore.Client,
	nameIndex map[string]map[string][]string,
	explorerFilter string,
	aliases map[string]string,
	apply bool,
) (summary, error) {
	out := summary{
		noMatchSenderNames: map[string]int{},
	}

	iter := client.Collection("reflections").Documents(ctx)
	for {
		doc, err := iter.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return out, err
		}

		out.scannedTotal++
		data := doc.Data()

		explorerID, _ := data["explorerId"].(string)
		if explorerID == "" {
			out.missingExplorer++
			if len(out.missingExplorerDocs) < 100 {
				out.missingExplorerDocs = append(out.missingExplorerDocs, doc.Ref.ID)
			}
			continue
		}
		if explorerFilter != "" && explorerID != explorerFilter {
			out.skippedByExplorer++
			continue
		}
		out.scannedTarget++

		if _, exists := data["sender_id"]; exists {
			out.alreadySet++
			continue
		}

		sender, _ := data["sender"].(string)
		senderKey := normalizeName(sender)
		if senderKey == "" {
			out.missingSender++
			if len(out.missingSenderDocs) < 100 {
				out.missingSenderDocs = append(out.missingSenderDocs, doc.Ref.ID)
			}
			continue
		}
		if aliased, ok := aliases[senderKey]; ok {
			senderKey = aliased
		}

		byName, ok := nameIndex[explorerID]
		if !ok {
			out.noMatch++
			out.noMatchSenderNames[sender]++
			continue
		}
		candidates := byName[senderKey]
		if len(candidates) == 0 {
			uniqueUsers := uniqueUserIDs(byName)
			if len(uniqueUsers) == 1 {
				candidates = []string{uniqueUsers[0]}
				out.fallbackUsed++
			} else {
				out.noMatch++
				out.noMatchSenderNames[sender]++
				continue
			}
		}
		if len(candidates) > 1 {
			out.ambiguous++
			if len(out.ambiguousExamples) < 25 {
				out.ambiguousExamples = append(out.ambiguousExamples,
					fmt.Sprintf("reflection=%s explorer=%s sender=%q candidates=%v", doc.Ref.ID, explorerID, sender, candidates))
			}
			continue
		}

		if apply {
			_, err = doc.Ref.Update(ctx, []firestore.Update{
				{Path: "sender_id", Value: candidates[0]},
			})
			if err != nil {
				out.writeErrors++
				continue
			}
		}
		out.updated++
	}

	return out, nil
}

func uniqueUserIDs(byName map[string][]string) []string {
	seen := map[string]struct{}{}
	for _, users := range byName {
		for _, userID := range users {
			if userID == "" {
				continue
			}
			seen[userID] = struct{}{}
		}
	}

	out := make([]string, 0, len(seen))
	for userID := range seen {
		out = append(out, userID)
	}
	sort.Strings(out)
	return out
}
