#!/bin/bash
# Installed in the background while the script is being written: fonts for the subtitles, Cairo/Pango and Manim for the animations, Chromium for the template player.
touch /tmp/heavy.started
{
  sudo apt-get install -y -q --no-install-recommends fonts-noto-cjk libcairo2-dev libpango1.0-dev pkg-config \
    || { sudo apt-get update -q && sudo apt-get install -y -q --no-install-recommends fonts-noto-cjk libcairo2-dev libpango1.0-dev pkg-config; }
  pip install -q playwright manim
  python -m playwright install --with-deps chromium
} > /tmp/heavy.log 2>&1 && touch /tmp/heavy.done || touch /tmp/heavy.failed
