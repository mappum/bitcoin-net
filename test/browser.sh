#!/bin/sh

if [ $BROWSER ]; then
  zuul \
    --browser-name $BROWSER \
    --browser-version latest \
    --ui tape \
    --tunnel ngrok \
    -- test/build/*.js
else
  zuul --local --ui tape -- test/build/*.js
fi
