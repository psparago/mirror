import React, { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Image, StyleSheet, Text, View, useWindowDimensions, TouchableOpacity, Modal } from 'react-native';
import { API_ENDPOINTS, Event, EventMetadata, ListEventsResponse } from '@projectmirror/shared';

export default function TabTwoScreen() {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);
  const [eventMetadata, setEventMetadata] = useState<{ [key: string]: EventMetadata }>({});
  const { width } = useWindowDimensions();
  
  // Responsive column count: 2 for iPhone, 4-5 for iPad
  const numColumns = width >= 768 ? (width >= 1024 ? 5 : 4) : 2;

  useEffect(() => {
    fetchEvents();
  }, []);

  const fetchEvents = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch(API_ENDPOINTS.LIST_MIRROR_PHOTOS);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch events: ${response.status}`);
      }
      
      const data: ListEventsResponse = await response.json();
      setEvents(data.events || []);
      
      // Fetch metadata for each event
      const metadataPromises = (data.events || []).map(async (event) => {
        if (event.metadata_url) {
          try {
            const metaResponse = await fetch(event.metadata_url);
            if (metaResponse.ok) {
              const metadata: EventMetadata = await metaResponse.json();
              return { eventId: event.event_id, metadata };
            }
          } catch (err) {
            console.warn(`Failed to fetch metadata for ${event.event_id}:`, err);
          }
        }
        return null;
      });
      
      const metadataResults = await Promise.all(metadataPromises);
      const metadataMap: { [key: string]: EventMetadata } = {};
      metadataResults.forEach(result => {
        if (result) {
          metadataMap[result.eventId] = result.metadata;
        }
      });
      setEventMetadata(metadataMap);
    } catch (err: any) {
      console.error('Error fetching events:', err);
      setError(err.message || 'Failed to load events');
    } finally {
      setLoading(false);
    }
  };

  const renderEvent = ({ item }: { item: Event }) => {
    const metadata = eventMetadata[item.event_id];
    const hasDescription = metadata?.description;
    
    return (
      <TouchableOpacity 
        style={styles.photoContainer}
        onPress={() => setSelectedEvent(item)}
        activeOpacity={0.8}
      >
        <Image
          source={{ uri: item.image_url }}
          style={styles.photo}
          resizeMode="cover"
        />
        {hasDescription && (
          <View style={styles.descriptionBadge}>
            <Text style={styles.descriptionBadgeText}>📝</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  const closeFullScreen = () => {
    setSelectedEvent(null);
  };

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#2e78b7" />
        <Text style={styles.loadingText}>Loading Cole's inbox...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.errorText}>Error: {error}</Text>
        <Text style={styles.retryText} onPress={fetchEvents}>
          Tap to retry
        </Text>
      </View>
    );
  }

  if (events.length === 0) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.emptyText}>No photos in Cole's inbox yet</Text>
        <Text style={styles.emptySubtext}>Photos from companions will appear here</Text>
      </View>
    );
  }

  const selectedMetadata = selectedEvent ? eventMetadata[selectedEvent.event_id] : null;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Cole's Inbox</Text>
      <FlatList
        key={numColumns}
        data={events}
        renderItem={renderEvent}
        keyExtractor={(item) => item.event_id}
        numColumns={numColumns}
        contentContainerStyle={styles.listContainer}
        columnWrapperStyle={numColumns > 1 ? styles.row : undefined}
      />

      {/* Full-screen modal with description */}
      <Modal
        visible={selectedEvent !== null}
        transparent={false}
        animationType="fade"
        onRequestClose={closeFullScreen}
      >
        {selectedEvent && (
          <View style={styles.fullScreenContainer}>
            <TouchableOpacity 
              style={styles.closeButton}
              onPress={closeFullScreen}
            >
              <Text style={styles.closeButtonText}>✕ Close</Text>
            </TouchableOpacity>
            
            <Image
              source={{ uri: selectedEvent.image_url }}
              style={styles.fullScreenImage}
              resizeMode="contain"
            />
            
            {selectedMetadata && selectedMetadata.description && (
              <View style={styles.descriptionContainer}>
                <Text style={styles.descriptionLabel}>From {selectedMetadata.sender}:</Text>
                <Text style={styles.descriptionText}>
                  {selectedMetadata.description}
                </Text>
              </View>
            )}
          </View>
        )}
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  centerContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    padding: 16,
    backgroundColor: '#f5f5f5',
  },
  listContainer: {
    padding: 8,
  },
  row: {
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  photoContainer: {
    flex: 1,
    margin: 4,
    aspectRatio: 1,
    backgroundColor: '#f0f0f0',
    borderRadius: 8,
    overflow: 'hidden',
    position: 'relative',
  },
  photo: {
    width: '100%',
    height: '100%',
  },
  descriptionBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(46, 120, 183, 0.9)',
    borderRadius: 20,
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
  descriptionBadgeText: {
    fontSize: 18,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: '#666',
  },
  errorText: {
    fontSize: 16,
    color: '#d32f2f',
    textAlign: 'center',
    marginBottom: 8,
  },
  retryText: {
    fontSize: 14,
    color: '#2e78b7',
    textDecorationLine: 'underline',
  },
  emptyText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#666',
    textAlign: 'center',
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 14,
    color: '#999',
    textAlign: 'center',
  },
  fullScreenContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  closeButton: {
    position: 'absolute',
    top: 50,
    right: 20,
    zIndex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    padding: 12,
    borderRadius: 8,
  },
  closeButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  fullScreenImage: {
    flex: 1,
    width: '100%',
  },
  descriptionContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.85)',
    padding: 24,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  descriptionLabel: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  descriptionText: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '600',
    lineHeight: 32,
  },
});
