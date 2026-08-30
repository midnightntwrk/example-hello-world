import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const moods = ['😊', '🙂', '😐', '😔', '😣'];

function App() {
  const [mood, setMood] = useState('');
  const [message, setMessage] = useState('');
  const [entries, setEntries] = useState<string[]>([]);

  const [saving, setSaving] = useState(false);

  const [chatMessage, setChatMessage] = useState('');
  const [aiReply, setAiReply] = useState(
    "Hi. I'm here to listen. What's been on your mind today?"
  );
  const [thinking, setThinking] = useState(false);

  /*
   * Save journal entry to Midnight
   */
  const saveEntry = async () => {
    if (!message.trim() || saving) return;

    const text = message.trim();

    setSaving(true);

    try {
      const response = await fetch('http://localhost:3001/api/journal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: text,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to save journal entry');
      }

      setEntries((prev) => [...prev, text]);
      setMessage('');

      /*
       * Show success only after Midnight confirms the transaction.
       */
      alert(
        `Saved privately on Midnight.\nJournal count: ${data.journalCount}`
      );
    } catch (error) {
      console.error('Journal error:', error);

      alert(
        error instanceof Error
          ? error.message
          : 'Could not save your journal entry to Midnight.'
      );
    } finally {
      setSaving(false);
    }
  };

  /*
   * Send message to MindVault AI
   */
  const sendMessage = async () => {
    if (!chatMessage.trim() || thinking) return;

    const text = chatMessage.trim();

    setChatMessage('');
    setThinking(true);

    try {
      const response = await fetch('http://localhost:3001/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: text,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'AI request failed');
      }

      setAiReply(data.reply);
    } catch (error) {
      console.error('Chat error:', error);

      setAiReply(
        'Sorry, I could not connect to MindVault AI right now.'
      );
    } finally {
      setThinking(false);
    }
  };

  return (
    <main className="app">

      {/* HEADER */}
      <header>
        <div>
          <p className="eyebrow">MIDNIGHT × AI</p>

          <h1>MindVault</h1>

          <p className="subtitle">
            A private space to reflect, understand, and take care of your mind.
          </p>
        </div>

        <div className="privacy">
          🔒 Private by design
        </div>
      </header>


      {/* HERO */}
      <section className="hero">
        <div>
          <span className="badge">
            AI WELLNESS COMPANION
          </span>

          <h2>
            Your thoughts deserve privacy.
          </h2>

          <p>
            Reflect freely, talk with an AI companion,
            and store your personal journal entries privately.
          </p>
        </div>
      </section>


      {/* MAIN GRID */}
      <section className="grid">

        {/* MOOD */}
        <div className="card">

          <h3>How are you feeling?</h3>

          <div className="moods">

            {moods.map((item) => (
              <button
                key={item}
                className={mood === item ? 'mood selected' : 'mood'}
                onClick={() => setMood(item)}
              >
                {item}
              </button>
            ))}

          </div>

          {mood && (
            <p className="todayMood">
              Today's mood: {mood}
            </p>
          )}

        </div>


        {/* JOURNAL */}
        <div className="card">

          <h3>Private journal</h3>

          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Write what's on your mind..."
            disabled={saving}
          />

          <button
            className="primary"
            onClick={saveEntry}
            disabled={saving || !message.trim()}
          >
            {saving ? '🔐 Saving privately...' : 'Save privately'}
          </button>

          {saving && (
            <p className="status">
              Securing your journal entry on Midnight...
            </p>
          )}

        </div>


        {/* AI CHAT */}
        <div className="card chat">

          <div className="cardTitle">

            <h3>
              MindVault AI
            </h3>

            <span>
              ● Online
            </span>

          </div>


          <div className="aiMessage">
            {thinking ? 'Thinking...' : aiReply}
          </div>


          <div className="chatInput">

            <input
              value={chatMessage}
              onChange={(e) => setChatMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  sendMessage();
                }
              }}
              placeholder="Share what's on your mind..."
              disabled={thinking}
            />

            <button
              onClick={sendMessage}
              disabled={thinking || !chatMessage.trim()}
            >
              {thinking ? '...' : '→'}
            </button>

          </div>

        </div>


        {/* PRIVACY */}
        <div className="card">

          <h3>Privacy status</h3>

          <div className="protected">

            <div className="check">
              ✓
            </div>

            <div>
              <strong>Protected</strong>

              <p>
                Private state secured with Midnight technology.
              </p>
            </div>

          </div>


          <div className="reflectionCount">

            <strong>
              {entries.length}
            </strong>

            <span>
              private reflections
            </span>

          </div>

        </div>

      </section>


      {/* RECENT ENTRIES */}
      {entries.length > 0 && (

        <section className="card entries">

          <h3>
            Current session
          </h3>

          {entries.map((entry, index) => (

            <div
              className="entry"
              key={`${entry}-${index}`}
            >
              <span>🔒</span>

              <p>
                {entry}
              </p>
            </div>

          ))}

        </section>

      )}

    </main>
  );
}

createRoot(
  document.getElementById('root')!
).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
