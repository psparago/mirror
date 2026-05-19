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
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

const (
	pendingNotificationsCollection = "pending_notifications"

	triggerCompanionUpload = "companion_upload"
	triggerExplorerLike    = "explorer_like"
	pendingStatus          = "pending"
)

type pendingNotification struct {
	ExplorerID               string   `firestore:"explorerId"`
	BroadcastToAllCompanions bool     `firestore:"broadcastToAllCompanions"`
	RecipientIDs             []string `firestore:"recipientIds"`
	TriggerType              string   `firestore:"triggerType"`
	ReflectionID             string   `firestore:"reflectionId"`
	SenderID                 string   `firestore:"senderId"`
	SenderName               string   `firestore:"senderName"`
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

// OnReflectionCreated stages a notification whenever a Companion creates a new Reflection.
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

	notification := pendingNotification{
		ExplorerID:               explorerID,
		BroadcastToAllCompanions: true,
		RecipientIDs:             []string{},
		TriggerType:              triggerCompanionUpload,
		ReflectionID:             id,
		SenderID:                 senderID(doc),
		SenderName:               senderName(doc),
		Status:                   pendingStatus,
		CreatedAt:                firestore.ServerTimestamp,
	}
	return createPendingNotification(ctx, client, fmt.Sprintf("%s_%s", triggerCompanionUpload, id), notification)
}

// OnReflectionUpdated stages a notification when the Explorer newly likes a Reflection.
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

	beforeLikedBy := stringArrayField(before, "likedBy")
	afterLikedBy := stringArrayField(after, "likedBy")
	if !containsString(afterLikedBy, explorerID) || containsString(beforeLikedBy, explorerID) {
		return nil
	}

	recipientID := senderID(after)
	if recipientID == "" {
		fmt.Printf("OnReflectionUpdated: skipping explorer_like for %s; missing sender_id\n", id)
		return nil
	}

	client, err := firestoreClient(ctx)
	if err != nil {
		return err
	}
	defer client.Close()

	notification := pendingNotification{
		ExplorerID:               explorerID,
		BroadcastToAllCompanions: false,
		RecipientIDs:             []string{recipientID},
		TriggerType:              triggerExplorerLike,
		ReflectionID:             id,
		SenderName:               senderName(after),
		Status:                   pendingStatus,
		CreatedAt:                firestore.ServerTimestamp,
	}
	return createPendingNotification(ctx, client, fmt.Sprintf("%s_%s_%s", triggerExplorerLike, id, explorerID), notification)
}
