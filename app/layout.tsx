import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Door View Creator',
  description: 'Create and analyze door views from IFC files',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
