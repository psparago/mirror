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

import { ExplorerConfig } from '@projectmirror/shared';
import { arrayUnion, auth, db, doc, getDoc, updateDoc } from '@projectmirror/shared/firebase';

export function DeviceSetupScreen() {
  const [explorerIdInput, setExplorerIdInput] = useState('');
  const [loading, setLoading] = useState(false);
  const deviceUid = auth.currentUser?.uid || 'Unknown';

  const handleConnect = async () => {
    const targetId = explorerIdInput.trim();
    
    if (!targetId) {
      Alert.alert("Input Required", "Please enter an Explorer ID.");
      return;
    }

    setLoading(true);

    try {
      const explorerRef = doc(db, ExplorerConfig.collections.explorers, targetId);
      const explorerSnap = await getDoc(explorerRef);

      if (!explorerSnap.exists()) {
        Alert.alert("Invalid ID", "Could not find an Explorer with that ID.");
        setLoading(false);
        return;
      }

      await updateDoc(explorerRef, {
        authorizedDevices: arrayUnion(deviceUid)
      });
      
    } catch (error: any) {
      console.error("Setup Error:", error);
      Alert.alert("Connection Failed", error.message);
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView 
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={styles.container}
    >
      <View style={styles.card}>
        <Text style={styles.title}>Reflections</Text>
        <Text style={styles.subtitle}>
          Link this device to an Explorer
        </Text>

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

        <TouchableOpacity 
          style={[styles.button, loading && styles.buttonDisabled]} 
          onPress={handleConnect}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Connect Device</Text>
          )}
        </TouchableOpacity>

        <View style={styles.footer}>
          <Text style={styles.debugText}>Device Identifier:</Text>
          <Text style={styles.debugCode}>{deviceUid}</Text>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121212', // Dark background
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  card: {
    backgroundColor: '#1e1e1e', // Slightly lighter card
    borderRadius: 20,
    padding: 40,
    width: '100%',
    maxWidth: 500,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333', // Subtle border
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 10,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    marginBottom: 8,
    color: '#fff', // White text
    letterSpacing: 0.5,
  },
  subtitle: {
    fontSize: 16,
    color: '#aaa', // Light gray subtitle
    marginBottom: 40,
    textAlign: 'center',
  },
  inputContainer: {
    width: '100%',
    marginBottom: 24,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: '#888', // Subtle label
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  input: {
    backgroundColor: '#2c2c2c', // Dark input
    borderRadius: 12,
    padding: 16,
    fontSize: 20,
    color: '#fff', // White text input
    borderWidth: 1,
    borderColor: '#333',
  },
  button: {
    backgroundColor: '#2e78b7', // Angelware Blue
    width: '100%',
    padding: 18,
    borderRadius: 14,
    alignItems: 'center',
    marginTop: 10,
  },
  buttonDisabled: {
    backgroundColor: '#1a4f7a', // Darker blue when disabled
    opacity: 0.7,
  },
  buttonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  footer: {
    marginTop: 40,
    alignItems: 'center',
    opacity: 0.5,
  },
  debugText: {
    fontSize: 12,
    color: '#888',
  },
  debugCode: {
    fontSize: 12,
    color: '#666',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 4,
  }
});