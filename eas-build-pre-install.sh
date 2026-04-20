#!/bin/bash
if [[ "$EAS_BUILD_PLATFORM" == "android" ]]; then
  echo "Installing legacy libncurses5 for RenderScript support..."
  sudo apt-get --quiet update --yes
  sudo apt-get --quiet install --yes libncurses5 || {
    echo "libncurses5 not found, attempting symlink workaround..."
    sudo ln -s /usr/lib/x86_64-linux-gnu/libncurses.so.6 /usr/lib/x86_64-linux-gnu/libncurses.so.5
    sudo ln -s /usr/lib/x86_64-linux-gnu/libtinfo.so.6 /usr/lib/x86_64-linux-gnu/libtinfo.so.5
  }
fi
