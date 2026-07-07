#!/usr/bin/env bash
# AODP — Initial setup script

set -e

echo "🚀 Setting up AODP..."

# Check requirements
command -v node >/dev/null 2>&1 || { echo "Node.js is required. Install from nodejs.org"; exit 1; }
command -v pnpm >/dev/null 2>&1 || npm install -g pnpm

# Install dependencies
echo "📦 Installing dependencies..."
pnpm install

# Copy environment file
if [ ! -f ".env.local" ]; then
  cp .env.example .env.local
  echo "⚠️  Created .env.local — please fill in your Supabase credentials"
fi

echo "✅ Setup complete! Run 'pnpm dev' to start the development server."
