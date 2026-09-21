import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
    {/* Always-visible build version (even on the sign-in screen), so it's
        always clear which build is running. Baked in by vite (see config). */}
    <div className="version-badge" title="App version">v{__APP_VERSION__}</div>
  </React.StrictMode>
)
