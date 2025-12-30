import React, { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Image, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

interface PhotoItem {
  url: string;
}

export default function TabTwoScreen() {
  const [photos, setPhotos] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { width } = useWindowDimensions();
  
  // Responsive column count: 2 for iPhone, 4-5 for iPad
  // iPad is typically 768px+ in portrait, 1024px+ in landscape
  const numColumns = width >= 768 ? (width >= 1024 ? 5 : 4) : 2;

  useEffect(() => {
    fetchPhotos();
  }, []);

  const fetchPhotos = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch('https://us-central1-project-mirror-23168.cloudfunctions.net/list-mirror-photos');
      
      if (!response.ok) {
        throw new Error(`Failed to fetch photos: ${response.status}`);
      }
      
      const data = await response.json();
      setPhotos(data.objects || []);
    } catch (err: any) {
      console.error('Error fetching photos:', err);
      setError(err.message || 'Failed to load photos');
    } finally {
      setLoading(false);
    }
  };

  const renderPhoto = ({ item }: { item: string }) => {
    return (
      <View style={styles.photoContainer}>
        <Image
          source={{ uri: item }}
          style={styles.photo}
          resizeMode="cover"
        />
      </View>
    );
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
        <Text style={styles.retryText} onPress={fetchPhotos}>
          Tap to retry
        </Text>
      </View>
    );
  }

  if (photos.length === 0) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.emptyText}>No photos in Cole's inbox yet</Text>
        <Text style={styles.emptySubtext}>Photos from companions will appear here</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Cole's Inbox</Text>
      <FlatList
        key={numColumns} // Force re-render when numColumns changes (on rotation)
        data={photos}
        renderItem={renderPhoto}
        keyExtractor={(item, index) => item || index.toString()}
        numColumns={numColumns}
        contentContainerStyle={styles.listContainer}
        columnWrapperStyle={numColumns > 1 ? styles.row : undefined}
      />
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
  },
  photo: {
    width: '100%',
    height: '100%',
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
});
