import { doc, getDoc } from 'firebase/firestore';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { db } from '../firebase';
import { Relationship, useRelationships } from '../hooks/useRelationships';
import { ExplorerConfig } from './ExplorerConfig';

interface ExplorerContextType {
  currentExplorerId: string | null;
  explorerName: string | null;
  activeRelationship: Relationship | null;
  loading: boolean;
  switchExplorer: (explorerId: string) => void;
}

const ExplorerContext = createContext<ExplorerContextType>({} as ExplorerContextType);

// Helper: capitalize first letter of each word (fallback for IDs without a stored name)
function capitalizeId(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

export function ExplorerProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  
  // 1. Fetch all relationships for this user
  const { relationships, loading: relLoading } = useRelationships(user?.uid);
  
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [explorerName, setExplorerName] = useState<string | null>(null);

  // 2. Auto-Select Logic
  // When relationships load, if we haven't picked one yet, pick the first one.
  useEffect(() => {
    if (!relLoading && relationships.length > 0 && !selectedId) {
      // Default to the first explorer found (e.g. Peter)
      setSelectedId(relationships[0].explorerId);
    }
  }, [relationships, relLoading, selectedId]);

  // Helper to find the full relationship object based on the ID
  const activeRelationship = relationships.find(r => r.explorerId === selectedId) || null;

  // 3. Resolve Explorer Name
  // Priority: relationship.explorerName > explorer doc name > capitalized ID
  useEffect(() => {
    if (!selectedId) {
      setExplorerName(null);
      return;
    }

    // Check if the relationship already has the name stored
    if (activeRelationship?.explorerName) {
      setExplorerName(activeRelationship.explorerName);
      return;
    }

    // Fallback: fetch from the explorers collection
    let cancelled = false;
    (async () => {
      try {
        const explorerDoc = await getDoc(doc(db, ExplorerConfig.collections.explorers, selectedId));
        if (!cancelled && explorerDoc.exists()) {
          const data = explorerDoc.data();
          console.log(`[ExplorerContext] Explorer doc fields:`, Object.keys(data || {}));
          // Try multiple possible field names for the display name
          const name = data?.displayName || data?.display_name || data?.name;
          console.log(`[ExplorerContext] Resolved name: "${name}" for ID: ${selectedId}`);
          setExplorerName(name || capitalizeId(selectedId));
        } else if (!cancelled) {
          console.warn(`[ExplorerContext] Explorer doc not found for ID: ${selectedId}`);
          setExplorerName(capitalizeId(selectedId));
        }
      } catch (err) {
        console.warn(`[ExplorerContext] Failed to fetch explorer doc:`, err);
        if (!cancelled) {
          setExplorerName(capitalizeId(selectedId));
        }
      }
    })();

    return () => { cancelled = true; };
  }, [selectedId, activeRelationship?.explorerName]);

  const switchExplorer = (id: string) => {
    // Only switch if we actually have a relationship with this ID
    if (relationships.some(r => r.explorerId === id)) {
      setSelectedId(id);
    }
  };

  return (
    <ExplorerContext.Provider 
      value={{ 
        currentExplorerId: selectedId, 
        explorerName,
        activeRelationship,
        loading: relLoading,
        switchExplorer 
      }}
    >
      {children}
    </ExplorerContext.Provider>
  );
}

export const useExplorer = () => useContext(ExplorerContext);