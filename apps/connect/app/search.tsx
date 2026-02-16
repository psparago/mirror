import { useReflectionMedia } from '@/context/ReflectionMediaContext';
import { prepareImageForUpload } from '@/utils/mediaProcessor';
import { FontAwesome } from '@expo/vector-icons';
import { API_ENDPOINTS } from '@projectmirror/shared';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

export default function SearchScreen() {
  const router = useRouter();
  const { setPendingMedia } = useReflectionMedia();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingImage, setIsLoadingImage] = useState(false);

  const searchUnsplash = async (query: string) => {
    if (!query.trim()) return;
    setIsSearching(true);
    setSearchResults([]);
    try {
      const response = await fetch(`${API_ENDPOINTS.UNSPLASH_SEARCH}?query=${encodeURIComponent(query)}`);
      if (!response.ok) {
        setSearchResults([]);
        return;
      }
      const data = await response.json();
      setSearchResults(data.results || []);
    } catch (error: any) {
      console.error('Unsplash search error:', error);
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  const handleQuickPick = (term: string) => {
    setSearchQuery(term);
    searchUnsplash(term);
  };

  const handleImageSelect = async (imageUrl: string) => {
    try {
      setIsLoadingImage(true);
      const optimizedUri = await prepareImageForUpload(imageUrl);
      setPendingMedia({ uri: optimizedUri, type: 'photo', source: 'search' });
      router.back();
    } catch (error: any) {
      console.error('handleImageSelect error:', error);
      Alert.alert('Error', 'Failed to prepare selected image for upload.');
    } finally {
      setIsLoadingImage(false);
    }
  };

  return (
    <View style={styles.container}>
      {/* Loading overlay */}
      {isLoadingImage && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.loadingOverlayText}>Preparing image...</Text>
        </View>
      )}

      {/* Fixed Header Section */}
      <View style={styles.fixedHeader}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.closeButton} onPress={() => router.back()}>
            <FontAwesome name="times" size={24} color="white" />
          </TouchableOpacity>
          <Text style={styles.title}>Search Images</Text>
          <View style={styles.closeButtonPlaceholder} />
        </View>

        <View style={styles.searchBarContainer}>
          <TextInput
            style={styles.searchInput}
            placeholder="Search for images..."
            placeholderTextColor="#999"
            value={searchQuery}
            onChangeText={setSearchQuery}
            onSubmitEditing={() => searchUnsplash(searchQuery)}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
          />
          <TouchableOpacity
            style={styles.searchSubmitButton}
            onPress={() => searchUnsplash(searchQuery)}
            disabled={isSearching || !searchQuery.trim()}
          >
            {isSearching ? (
              <ActivityIndicator size="small" color="white" />
            ) : (
              <FontAwesome name="search" size={20} color="white" />
            )}
          </TouchableOpacity>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chipsContainer}
          contentContainerStyle={styles.chipsContent}
        >
          {['Sushi', 'Ice Cream Truck', 'Trains', 'mac and cheese'].map((term) => (
            <TouchableOpacity key={term} style={styles.chip} onPress={() => handleQuickPick(term)}>
              <Text style={styles.chipText}>{term}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* Results Area */}
      <View style={styles.resultsArea}>
        {isSearching && searchResults.length === 0 ? (
          <View style={styles.emptyContainer}>
            <ActivityIndicator size="large" color="#2e78b7" />
            <Text style={styles.emptyText}>Searching...</Text>
          </View>
        ) : searchResults.length > 0 ? (
          <FlatList
            data={searchResults}
            numColumns={2}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.resultsGrid}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.resultItem}
                onPress={() => handleImageSelect(item.urls.regular || item.urls.small)}
                activeOpacity={0.8}
              >
                <Image
                  source={{ uri: item.urls.small || item.urls.regular }}
                  style={styles.resultImage}
                  contentFit="cover"
                  recyclingKey={item.id}
                  cachePolicy="memory-disk"
                />
              </TouchableOpacity>
            )}
          />
        ) : searchQuery.trim() ? (
          <View style={styles.emptyContainer}>
            <FontAwesome name="image" size={48} color="#666" />
            <Text style={styles.emptyText}>No images found for "{searchQuery}"</Text>
            <Text style={styles.emptySubtext}>Try a different search term</Text>
          </View>
        ) : (
          <View style={styles.emptyContainer}>
            <FontAwesome name="search" size={48} color="#666" />
            <Text style={styles.emptyText}>Search for images to get started</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
  },
  loadingOverlayText: {
    color: '#fff',
    marginTop: 12,
    fontSize: 14,
  },
  fixedHeader: {
    backgroundColor: '#1a1a2e',
    paddingTop: 60,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeButtonPlaceholder: {
    width: 40,
  },
  title: {
    color: '#fff',
    fontSize: 20,
    fontWeight: 'bold',
  },
  searchBarContainer: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  searchInput: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    color: '#fff',
    marginRight: 10,
  },
  searchSubmitButton: {
    backgroundColor: '#2e78b7',
    borderRadius: 12,
    width: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipsContainer: {
    paddingHorizontal: 16,
  },
  chipsContent: {
    gap: 8,
  },
  chip: {
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  chipText: {
    color: '#fff',
    fontSize: 14,
  },
  resultsArea: {
    flex: 1,
  },
  resultsGrid: {
    padding: 8,
  },
  resultItem: {
    flex: 1,
    margin: 4,
    borderRadius: 12,
    overflow: 'hidden',
    aspectRatio: 1,
  },
  resultImage: {
    width: '100%',
    height: '100%',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  emptyText: {
    color: '#aaa',
    fontSize: 16,
    marginTop: 16,
    textAlign: 'center',
  },
  emptySubtext: {
    color: '#666',
    fontSize: 14,
    marginTop: 8,
  },
});
