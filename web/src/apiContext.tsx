import React, { createContext, useContext, useMemo } from 'react';
import { useAuth } from '@/components/AuthGate';
import { createGatewayApi, type GatewayApi } from './api';

const ApiContext = createContext<GatewayApi | null>(null);

/** Gives the pages a client whose requests go through the session: a 401 returns to login. */
export function ApiProvider({ children }: { children: React.ReactNode }) {
  const { authFetch } = useAuth();
  const api = useMemo(() => createGatewayApi(authFetch), [authFetch]);
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): GatewayApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApi must be used within ApiProvider');
  return api;
}
