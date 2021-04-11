#!/bin/sh

npm install

node server.js https://"$1":"$2" "$3" "$4"
