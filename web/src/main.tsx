import React from 'react';
import ReactDOM from 'react-dom/client';
import { Toaster } from '@/components/ui/sonner';
import { AuthGate } from '@/components/AuthGate';
import GatewayApp from './GatewayApp';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate prefix="/api/gateway">
      <GatewayApp />
    </AuthGate>
    <Toaster />
  </React.StrictMode>
);
