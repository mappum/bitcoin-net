#!/bin/sh

if [ $BROWSER ]; then
  zuul \
    --browser-name $BROWSER \
    --browser-version latest \
    --ui tape \
    -- test/*.js \
    || exit 1
else
  zuul --local --ui tape -- test/*.js || exit 1
fi
