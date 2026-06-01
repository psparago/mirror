package functions

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"cloud.google.com/go/compute/metadata"
	"cloud.google.com/go/firestore"
	"github.com/cloudevents/sdk-go/v2/event"
	firestoredata "github.com/googleapis/google-cloudevents-go/cloud/firestoredata"
	"google.golang.org/api/iterator"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

const (
	pendingNotificationsCollection = "pending_notifications"
	relationshipsCollection        = "relationships"
	reflectionsCollection          = "reflections"

	triggerCompanionUpload   = "companion_upload"
	triggerCompanionReaction = "companion_reaction"
	triggerExplorerLike      = "explorer_like"
	triggerCompanionLike     = "companion_like"
	pendingStatus          = "pending"
)

type pendingNotification struct {
	ExplorerID               string   `firestore:"explorerId"`
	BroadcastToAllCompanions bool     `firestore:"broadcastToAllCompanions"`
	RecipientIDs             []string `firestore:"recipientIds"`
	TriggerType              string   `firestore:"triggerType"`
	ReflectionID             string   `firestore:"reflectionId"`
	ParentReflectionID           string `firestore:"parentReflectionId,omitempty"`
	ParentReflectionAuthorName   string `firestore:"parentReflectionAuthorName,omitempty"`
	SenderID                     string `firestore:"senderId"`
	SenderName                   string `firestore:"senderName"`
	LikerID                  string   `firestore:"likerId,omitempty"`
	LikerName                string   `firestore:"likerName,omitempty"`
	Status                   string   `firestore:"status"`
	CreatedAt                any      `firestore:"createdAt"`
}

func firestoreProjectID() (string, error) {
	projectID := os.Getenv("GCP_PROJECT")
	if projectID == "" {
		projectID = os.Getenv("GOOGLE_CLOUD_PROJECT")
	}
	if projectID == "" {
		var err error
		projectID, err = metadata.ProjectID()
		if err != nil {
			return "", fmt.Errorf("could not determine GCP project ID: %w", err)
		}
	}
	return projectID, nil
}

func firestoreClient(ctx context.Context) (*firestore.Client, error) {
	projectID, err := firestoreProjectID()
	if err != nil {
		return nil, err
	}
	client, err := firestore.NewClient(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("Firestore client: %w", err)
	}
	return client, nil
}

func decodeDocumentEvent(e event.Event) (*firestoredata.DocumentEventData, error) {
	var data firestoredata.DocumentEventData
	options := proto.UnmarshalOptions{DiscardUnknown: true}
	if err := options.Unmarshal(e.Data(), &data); err != nil {
		return nil, fmt.Errorf("proto.Unmarshal: %w", err)
	}
	return &data, nil
}

func documentID(doc *firestoredata.Document) string {
	if doc == nil {
		return ""
	}
	parts := strings.Split(doc.GetName(), "/")
	if len(parts) == 0 {
		return ""
	}
	return parts[len(parts)-1]
}

func stringField(doc *firestoredata.Document, key string) string {
	if doc == nil {
		return ""
	}
	value, ok := doc.GetFields()[key]
	if !ok {
		return ""
	}
	return value.GetStringValue()
}

func metadataStringField(doc *firestoredata.Document, key string) string {
	if doc == nil {
		return ""
	}
	metadataValue, ok := doc.GetFields()["metadata"]
	if !ok || metadataValue.GetMapValue() == nil {
		return ""
	}
	value, ok := metadataValue.GetMapValue().GetFields()[key]
	if !ok {
		return ""
	}
	return value.GetStringValue()
}

func reflectionID(doc *firestoredata.Document) string {
	if id := stringField(doc, "event_id"); id != "" {
		return id
	}
	return documentID(doc)
}

func senderName(doc *firestoredata.Document) string {
	if sender := stringField(doc, "sender"); sender != "" {
		return sender
	}
	if sender := metadataStringField(doc, "sender"); sender != "" {
		return sender
	}
	return "Companion"
}

func senderID(doc *firestoredata.Document) string {
	if id := stringField(doc, "sender_id"); id != "" {
		return id
	}
	return metadataStringField(doc, "sender_id")
}

func boolField(doc *firestoredata.Document, key string) bool {
	if doc == nil {
		return false
	}
	value, ok := doc.GetFields()[key]
	if !ok {
		return false
	}
	return value.GetBooleanValue()
}

func isReactionDocument(doc *firestoredata.Document) bool {
	return boolField(doc, "isReaction")
}

func parentReflectionID(doc *firestoredata.Document) string {
	return stringField(doc, "parentReflectionId")
}

func stringArrayField(doc *firestoredata.Document, key string) []string {
	if doc == nil {
		return nil
	}
	value, ok := doc.GetFields()[key]
	if !ok || value.GetArrayValue() == nil {
		return nil
	}
	values := value.GetArrayValue().GetValues()
	result := make([]string, 0, len(values))
	for _, item := range values {
		if s := item.GetStringValue(); s != "" {
			result = append(result, s)
		}
	}
	return result
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func newlyAddedLikedBy(before, after []string) []string {
	beforeSet := make(map[string]struct{}, len(before))
	for _, value := range before {
		beforeSet[value] = struct{}{}
	}
	added := make([]string, 0)
	for _, value := range after {
		if value == "" {
			continue
		}
		if _, seen := beforeSet[value]; !seen {
			added = append(added, value)
		}
	}
	return added
}

func senderNameFromReflectionData(data map[string]any, explorerID string, client *firestore.Client, ctx context.Context) string {
	if data == nil {
		return "a Companion"
	}
	if sender, ok := data["sender"].(string); ok && strings.TrimSpace(sender) != "" {
		return strings.TrimSpace(sender)
	}
	if metadata, ok := data["metadata"].(map[string]any); ok {
		if sender, ok := metadata["sender"].(string); ok && strings.TrimSpace(sender) != "" {
			return strings.TrimSpace(sender)
		}
		if senderID, ok := metadata["sender_id"].(string); ok && strings.TrimSpace(senderID) != "" {
			return companionNameForUser(ctx, client, explorerID, strings.TrimSpace(senderID))
		}
	}
	if senderID, ok := data["sender_id"].(string); ok && strings.TrimSpace(senderID) != "" {
		return companionNameForUser(ctx, client, explorerID, strings.TrimSpace(senderID))
	}
	return "a Companion"
}

func parentReflectionAuthorName(ctx context.Context, client *firestore.Client, explorerID, parentReflectionID string) string {
	if parentReflectionID == "" {
		return "a Companion"
	}
	doc, err := client.Collection(reflectionsCollection).Doc(parentReflectionID).Get(ctx)
	if err != nil {
		fmt.Printf("parentReflectionAuthorName: fetch %s failed: %v\n", parentReflectionID, err)
		return "a Companion"
	}
	return senderNameFromReflectionData(doc.Data(), explorerID, client, ctx)
}

func companionNameForUser(ctx context.Context, client *firestore.Client, explorerID, userID string) string {
	if userID == "" {
		return "A Companion"
	}
	iter := client.Collection(relationshipsCollection).
		Where("userId", "==", userID).
		Where("explorerId", "==", explorerID).
		Limit(1).
		Documents(ctx)
	doc, err := iter.Next()
	if err == iterator.Done {
		return "A Companion"
	}
	if err != nil {
		fmt.Printf("companionNameForUser: query failed for userId=%s explorerId=%s: %v\n", userID, explorerID, err)
		return "A Companion"
	}
	data := doc.Data()
	if name, ok := data["companionName"].(string); ok && strings.TrimSpace(name) != "" {
		return strings.TrimSpace(name)
	}
	return "A Companion"
}

func createPendingNotification(ctx context.Context, client *firestore.Client, docID string, notification pendingNotification) error {
	data := map[string]any{
		"explorerId":               notification.ExplorerID,
		"broadcastToAllCompanions": notification.BroadcastToAllCompanions,
		"recipientIds":             notification.RecipientIDs,
		"triggerType":              notification.TriggerType,
		"reflectionId":             notification.ReflectionID,
		"senderId":                 notification.SenderID,
		"senderName":               notification.SenderName,
		"status":                   notification.Status,
		"createdAt":                firestore.ServerTimestamp,
		"expireAt":                 time.Now().UTC().Add(30 * 24 * time.Hour),
	}
	if notification.LikerID != "" {
		data["likerId"] = notification.LikerID
	}
	if notification.LikerName != "" {
		data["likerName"] = notification.LikerName
	}
	if notification.ParentReflectionID != "" {
		data["parentReflectionId"] = notification.ParentReflectionID
	}
	if notification.ParentReflectionAuthorName != "" {
		data["parentReflectionAuthorName"] = notification.ParentReflectionAuthorName
	}
	_, err := client.Collection(pendingNotificationsCollection).Doc(docID).Create(ctx, data)
	if status.Code(err) == codes.AlreadyExists {
		fmt.Printf("pending notification %s already exists; treating retry as success\n", docID)
		return nil
	}
	if err != nil {
		return fmt.Errorf("create pending notification %s: %w", docID, err)
	}
	return nil
}

func updateRelationshipLastReflectionSent(ctx context.Context, client *firestore.Client, explorerID, senderID string) error {
	if senderID == "" {
		fmt.Printf("OnReflectionCreated: skipping relationship update; missing sender_id for explorer %s\n", explorerID)
		return nil
	}

	iter := client.Collection(relationshipsCollection).
		Where("userId", "==", senderID).
		Where("explorerId", "==", explorerID).
		Limit(1).
		Documents(ctx)
	doc, err := iter.Next()
	if err == iterator.Done {
		fmt.Printf("OnReflectionCreated: no relationship for userId=%s explorerId=%s\n", senderID, explorerID)
		return nil
	}
	if err != nil {
		return fmt.Errorf("query relationship for lastReflectionSentAt: %w", err)
	}

	_, err = doc.Ref.Update(ctx, []firestore.Update{
		{Path: "lastReflectionSentAt", Value: firestore.ServerTimestamp},
		{Path: "lastPostingReminderSentAt", Value: firestore.Delete},
	})
	if err != nil {
		return fmt.Errorf("update relationship %s lastReflectionSentAt: %w", doc.Ref.ID, err)
	}
	return nil
}

// OnReflectionCreated stages a notification when a Companion creates a Reflection or Reaction.
func OnReflectionCreated(ctx context.Context, e event.Event) error {
	data, err := decodeDocumentEvent(e)
	if err != nil {
		return err
	}
	doc := data.GetValue()
	if doc == nil {
		return fmt.Errorf("created event missing document value")
	}

	explorerID := stringField(doc, "explorerId")
	id := reflectionID(doc)
	if explorerID == "" || id == "" {
		fmt.Printf("OnReflectionCreated: skipping malformed reflection %s (explorerId=%q reflectionId=%q)\n", documentID(doc), explorerID, id)
		return nil
	}

	client, err := firestoreClient(ctx)
	if err != nil {
		return err
	}
	defer client.Close()

	sender := senderID(doc)
	if isReactionDocument(doc) {
		parentID := parentReflectionID(doc)
		if parentID == "" {
			fmt.Printf("OnReflectionCreated: skipping reaction %s; missing parentReflectionId\n", id)
			return nil
		}

		notification := pendingNotification{
			ExplorerID:                 explorerID,
			BroadcastToAllCompanions:   true,
			RecipientIDs:               []string{},
			TriggerType:                triggerCompanionReaction,
			ReflectionID:               id,
			ParentReflectionID:         parentID,
			ParentReflectionAuthorName: parentReflectionAuthorName(ctx, client, explorerID, parentID),
			SenderID:                   sender,
			SenderName:                 senderName(doc),
			Status:                     pendingStatus,
			CreatedAt:                  firestore.ServerTimestamp,
		}
		return createPendingNotification(ctx, client, fmt.Sprintf("%s_%s", triggerCompanionReaction, id), notification)
	}

	notification := pendingNotification{
		ExplorerID:               explorerID,
		BroadcastToAllCompanions: true,
		RecipientIDs:             []string{},
		TriggerType:              triggerCompanionUpload,
		ReflectionID:             id,
		SenderID:                 sender,
		SenderName:               senderName(doc),
		Status:                   pendingStatus,
		CreatedAt:                firestore.ServerTimestamp,
	}
	if err := createPendingNotification(ctx, client, fmt.Sprintf("%s_%s", triggerCompanionUpload, id), notification); err != nil {
		return err
	}
	return updateRelationshipLastReflectionSent(ctx, client, explorerID, sender)
}

// OnReflectionUpdated stages fast-lane notifications when the Explorer or a Companion newly likes a Reflection.
func OnReflectionUpdated(ctx context.Context, e event.Event) error {
	data, err := decodeDocumentEvent(e)
	if err != nil {
		return err
	}
	before := data.GetOldValue()
	after := data.GetValue()
	if after == nil {
		return nil
	}

	explorerID := stringField(after, "explorerId")
	id := reflectionID(after)
	if explorerID == "" || id == "" {
		fmt.Printf("OnReflectionUpdated: skipping malformed reflection %s (explorerId=%q reflectionId=%q)\n", documentID(after), explorerID, id)
		return nil
	}

	client, err := firestoreClient(ctx)
	if err != nil {
		return err
	}
	defer client.Close()

	beforeLikedBy := stringArrayField(before, "likedBy")
	afterLikedBy := stringArrayField(after, "likedBy")

	if err := stageExplorerLikeNotification(ctx, client, beforeLikedBy, afterLikedBy, explorerID, id, after); err != nil {
		return err
	}
	return stageCompanionLikeNotifications(ctx, client, beforeLikedBy, afterLikedBy, explorerID, id, after)
}

func stageExplorerLikeNotification(
	ctx context.Context,
	client *firestore.Client,
	beforeLikedBy, afterLikedBy []string,
	explorerID, reflectionID string,
	after *firestoredata.Document,
) error {
	if !containsString(afterLikedBy, explorerID) || containsString(beforeLikedBy, explorerID) {
		return nil
	}

	recipientID := senderID(after)
	if recipientID == "" {
		fmt.Printf("OnReflectionUpdated: skipping explorer_like for %s; missing sender_id\n", reflectionID)
		return nil
	}

	notification := pendingNotification{
		ExplorerID:               explorerID,
		BroadcastToAllCompanions: false,
		RecipientIDs:             []string{recipientID},
		TriggerType:              triggerExplorerLike,
		ReflectionID:             reflectionID,
		SenderName:               senderName(after),
		Status:                   pendingStatus,
		CreatedAt:                firestore.ServerTimestamp,
	}
	return createPendingNotification(ctx, client, fmt.Sprintf("%s_%s_%s", triggerExplorerLike, reflectionID, explorerID), notification)
}

func stageCompanionLikeNotifications(
	ctx context.Context,
	client *firestore.Client,
	beforeLikedBy, afterLikedBy []string,
	explorerID, reflectionID string,
	after *firestoredata.Document,
) error {
	recipientID := senderID(after)
	if recipientID == "" {
		return nil
	}

	for _, likerID := range newlyAddedLikedBy(beforeLikedBy, afterLikedBy) {
		if likerID == explorerID {
			continue
		}
		if likerID == recipientID {
			continue
		}

		notification := pendingNotification{
			ExplorerID:               explorerID,
			BroadcastToAllCompanions: false,
			RecipientIDs:             []string{recipientID},
			TriggerType:              triggerCompanionLike,
			ReflectionID:             reflectionID,
			SenderID:                 senderID(after),
			SenderName:               senderName(after),
			LikerID:                  likerID,
			LikerName:                companionNameForUser(ctx, client, explorerID, likerID),
			Status:                   pendingStatus,
			CreatedAt:                firestore.ServerTimestamp,
		}
		docID := fmt.Sprintf("%s_%s_%s", triggerCompanionLike, reflectionID, likerID)
		if err := createPendingNotification(ctx, client, docID, notification); err != nil {
			return err
		}
	}
	return nil
}
