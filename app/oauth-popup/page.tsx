'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'

function OAuthPopupContent() {
  const searchParams = useSearchParams()
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [message, setMessage] = useState('')

  useEffect(() => {
    const oauth = searchParams.get('oauth')
    const error = searchParams.get('error')

    if (oauth === 'success') {
      setStatus('success')
      setMessage('Authentication successful!')

      // Notify parent window
      if (window.opener) {
        window.opener.postMessage({ type: 'airtable-oauth-success' }, window.location.origin)
      }

      // Auto-close after 2 seconds
      setTimeout(() => {
        window.close()
      }, 2000)
    } else if (error) {
      setStatus('error')
      setMessage(decodeURIComponent(error))

      // Notify parent window
      if (window.opener) {
        window.opener.postMessage({ type: 'airtable-oauth-error', error }, window.location.origin)
      }
    }
  }, [searchParams])

  return (
    <div style={{
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      margin: 0,
      background: '#f8f9fa'
    }}>
      <div style={{
        textAlign: 'center',
        padding: '2rem',
        background: 'white',
        borderRadius: '8px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
      }}>
        {status === 'success' && (
          <h1 style={{ color: '#28a745' }}>✓ Connected to Airtable!</h1>
        )}
        {status === 'error' && (
          <h1 style={{ color: '#dc3545' }}>✗ Connection Failed</h1>
        )}
        {status === 'loading' && (
          <h1 style={{ color: '#666' }}>Processing...</h1>
        )}
        <p>{message}</p>
        <p style={{ color: '#666', fontSize: '0.9rem' }}>You can close this window.</p>
      </div>
    </div>
  )
}

export default function OAuthPopup() {
  return (
    <Suspense fallback={
      <div style={{
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        margin: 0,
        background: '#f8f9fa'
      }}>
        <div style={{
          textAlign: 'center',
          padding: '2rem',
          background: 'white',
          borderRadius: '8px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
        }}>
          <h1 style={{ color: '#666' }}>Loading...</h1>
        </div>
      </div>
    }>
      <OAuthPopupContent />
    </Suspense>
  )
}
