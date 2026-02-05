import React, { createContext, useContext, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { Relationship, useRelationships } from '../hooks/useRelationships';

interface ExplorerContextType {
  currentExplorerId: string | null;
  activeRelationship: Relationship | null;
  loading: boolean;
  switchExplorer: (explorerId: string) => void;
}

const ExplorerContext = createContext<ExplorerContextType>({} as ExplorerContextType);

export function ExplorerProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  
  // 1. Fetch all relationships for this user
  const { relationships, loading: relLoading } = useRelationships(user?.uid);
  
  const [selectedId, setSelectedId] = useState<string | null>(null);

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