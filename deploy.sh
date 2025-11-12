#!/bin/bash

echo "Installing dependencies..."
npm ci --only=production

echo "Building Strapi..."
npm run build

echo "Deployment complete!"
