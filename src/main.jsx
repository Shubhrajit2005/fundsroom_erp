import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './ui/App.jsx';
import './ui/styles.css';
import './ui/overrides.css';

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
