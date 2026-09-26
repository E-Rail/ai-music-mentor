import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { speakStoredLanguage } from './features/shell/useSettings'
import './index.css'

speakStoredLanguage()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
