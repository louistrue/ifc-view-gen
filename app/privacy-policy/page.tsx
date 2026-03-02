export default function PrivacyPolicy() {
  return (
    <div style={{ maxWidth: '800px', margin: '0 auto', padding: '2rem' }}>
      <h1>Privacy Policy</h1>
      <p><em>Last Updated: {new Date().toISOString().split('T')[0]}</em></p>

      <h2>Introduction</h2>
      <p>
        This Privacy Policy describes how Türbilder ("we", "our", or "us") handles data when you use our door view generation application.
      </p>

      <h2>Data We Collect</h2>
      <h3>IFC Files and Door Data</h3>
      <ul>
        <li><strong>Processing:</strong> IFC files and door data are processed entirely in your browser. We do not store, transmit, or access your IFC files.</li>
        <li><strong>Local Processing:</strong> All door analysis and SVG generation happens on your device.</li>
      </ul>

      <h3>Airtable Integration</h3>
      <p>When you connect to Airtable via OAuth:</p>
      <ul>
        <li><strong>Access Token:</strong> We temporarily store your Airtable OAuth access token in an encrypted browser session cookie for up to 8 hours.</li>
        <li><strong>Base Configuration:</strong> Your Airtable Base ID and Table Name are stored in the session cookie to facilitate uploads.</li>
        <li><strong>No Server Storage:</strong> We do NOT store your Airtable credentials on our servers. Tokens are session-only and automatically expire.</li>
      </ul>

      <h3>Uploaded Images</h3>
      <ul>
        <li><strong>Vercel Blob Storage:</strong> When you upload door views to Airtable, SVG images are temporarily stored in Vercel Blob Storage to generate public URLs for Airtable attachments.</li>
        <li><strong>Public URLs:</strong> These images are accessible via public URLs but are not indexed or listed.</li>
      </ul>

      <h2>How We Use Your Data</h2>
      <ul>
        <li>To process IFC files and generate door view SVGs in your browser</li>
        <li>To facilitate uploads to your Airtable workspace when you choose to connect</li>
        <li>To maintain your authenticated session for up to 8 hours</li>
      </ul>

      <h2>Data Security</h2>
      <ul>
        <li><strong>Encryption:</strong> Session cookies are encrypted using industry-standard encryption.</li>
        <li><strong>HTTPS:</strong> All data transmission uses HTTPS encryption.</li>
        <li><strong>No Logs:</strong> We do not log or store your IFC file data or Airtable credentials.</li>
      </ul>

      <h2>Third-Party Services</h2>
      <ul>
        <li><strong>Airtable:</strong> When you connect via OAuth, you grant our application permission to access your Airtable workspace. See <a href="https://www.airtable.com/privacy" target="_blank" rel="noopener noreferrer">Airtable's Privacy Policy</a>.</li>
        <li><strong>Vercel:</strong> Our application is hosted on Vercel. See <a href="https://vercel.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer">Vercel's Privacy Policy</a>.</li>
      </ul>

      <h2>Your Rights</h2>
      <ul>
        <li><strong>Disconnect:</strong> You can disconnect from Airtable at any time, which immediately clears your session.</li>
        <li><strong>Revoke Access:</strong> You can revoke our application's access from your Airtable account settings.</li>
        <li><strong>Data Deletion:</strong> Session data is automatically deleted when you disconnect or after 8 hours.</li>
      </ul>

      <h2>Sensitive Data Handling</h2>
      <p>
        We understand that IFC models may contain sensitive building information. Our application is designed with this in mind:
      </p>
      <ul>
        <li>All IFC processing happens locally in your browser</li>
        <li>No IFC data is transmitted to our servers</li>
        <li>You control what data (if any) is uploaded to your own Airtable workspace</li>
      </ul>

      <h2>Changes to This Policy</h2>
      <p>
        We may update this Privacy Policy from time to time. Changes will be posted on this page with an updated "Last Updated" date.
      </p>

      <h2>Contact</h2>
      <p>
        If you have questions about this Privacy Policy, please contact the developers via the repository.
      </p>
    </div>
  )
}
