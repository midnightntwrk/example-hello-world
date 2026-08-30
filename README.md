# MindVault — Private AI Wellness Companion

A privacy-focused AI wellness companion built on Midnight.

## Problem

People often hesitate to record personal thoughts, moods, and wellness information
because sensitive data can be exposed or stored centrally.

## Solution

MindVault combines an AI wellness companion with privacy-preserving blockchain
infrastructure. Users can interact with an AI companion and maintain private
journal activity without exposing sensitive journal content publicly.

## Features

- 🧠 AI wellness companion
- 🔒 Privacy-focused journaling
- 📔 Private journal recording using Midnight Compact
- 😊 Mood tracking
- 💬 AI-powered conversations
- 🌐 Web application
- 🧪 Automated Midnight contract tests

## Midnight Integration

MindVault uses a Midnight Compact smart contract to maintain private journal
activity.

### Smart Contract

`contracts/mindvault.compact`

The contract includes:

- `journalCount` — private ledger state
- `recordJournal()` — circuit used to record journal activity

### Architecture

User → MindVault Web App → Midnight Wallet/Providers → Compact Contract

The application is designed so that sensitive wellness information is not
directly exposed as public blockchain data.

## Tech Stack

- React
- TypeScript
- Vite
- Midnight Network
- Compact
- Node.js
- Yarn
- Docker
- Gemini API

## Running Locally

### Start Midnight Local Network

```bash
yarn env:up
