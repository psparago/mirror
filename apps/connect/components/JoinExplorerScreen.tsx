import { ExplorerConfig, useAuth } from '@projectmirror/shared';
import {
    addDoc,
    collection,
    db,
    doc,
    getDoc,
    serverTimestamp
} from '@projectmirror/shared/firebase';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    KeyboardAvoidingView,
    Platform,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View
} from 'react-native';

export function JoinExplorerScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const [explorerIdInput, setExplorerIdInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [loading, setLoading] = useState(false);

  const handleJoin = async () => {
    const targetId = explorerIdInput.trim();
    const myName = nameInput.trim();

    if (!targetId || !myName) {
      Alert.alert("Missing Info", "Please enter both the Explorer ID and your name.");
      return;
    }

    setLoading(true);

    try {
      // 1. Verify Explorer Exists
      const explorerRef = doc(db, ExplorerConfig.collections.explorers, targetId);
      const explorerSnap = await getDoc(explorerRef);

      if (!explorerSnap.exists()) {
        Alert.alert("Invalid ID", "Could not find an Explorer with that ID.");
        setLoading(false);
        return;
      }

      // Extract the Explorer's display name from the document
      const explorerData = explorerSnap.data();
      const explorerName = explorerData?.displayName || explorerData?.display_name || explorerData?.name || targetId;

      // 2. Create the Relationship
      // We don't need to check for duplicates here because the 
      // main app logic would have hidden this screen if one existed.
      await addDoc(collection(db, ExplorerConfig.collections.relationships), {
        explorerId: targetId,
        userId: user?.uid,
        role: 'companion',
        companionName: myName,
        explorerName: explorerName,
        createdAt: serverTimestamp(),
      });

      // Navigate to BootScreen which will see the new relationship and route to (tabs)
      router.replace('/');

    } catch (error: any) {
      console.error("Join Error:", error);
      Alert.alert("Join Failed", error.message);
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView 
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={styles.container}
    >
      <View style={styles.card}>
        <Text style={styles.title}>Welcome</Text>
        <Text style={styles.subtitle}>
          Connect to an Explorer to start sharing.
        </Text>

        {/* Input: Explorer ID */}
        <View style={styles.inputContainer}>
          <Text style={styles.label}>Explorer ID</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. COLE-01052010"
            placeholderTextColor="#666"
            value={explorerIdInput}
            onChangeText={setExplorerIdInput}
            autoCapitalize="characters"
            autoCorrect={false}
          />
        </View>

        {/* Input: My Name */}
        <View style={styles.inputContainer}>
          <Text style={styles.label}>My Name (For Them)</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. Mom, Uncle Mike"
            placeholderTextColor="#666"
            value={nameInput}
            onChangeText={setNameInput}
            autoCapitalize="words"
          />
        </View>

        <TouchableOpacity 
          style={[styles.button, loading && styles.buttonDisabled]} 
          onPress={handleJoin}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Join Explorer</Text>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121212', 
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  card: {
    backgroundColor: '#1e1e1e',
    borderRadius: 20,
    padding: 30,
    width: '100%',
    maxWidth: 400,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 10,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 8,
    color: '#fff',
    letterSpacing: 0.5,
  },
  subtitle: {
    fontSize: 16,
    color: '#aaa',
    marginBottom: 30,
    textAlign: 'center',
  },
  inputContainer: {
    width: '100%',
    marginBottom: 20,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: '#888',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  input: {
    backgroundColor: '#2c2c2c',
    borderRadius: 12,
    padding: 16,
    fontSize: 18,
    color: '#fff',
    borderWidth: 1,
    borderColor: '#333',
  },
  button: {
    backgroundColor: '#2e78b7',
    width: '100%',
    padding: 16,
    borderRadius: 14,
    alignItems: 'center',
    marginTop: 10,
  },
  buttonDisabled: {
    backgroundColor: '#1a4f7a',
    opacity: 0.7,
  },
  buttonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
});