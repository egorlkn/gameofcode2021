/* CONFIGURATION */

var OpenVidu = require('openvidu-node-client').OpenVidu;
var OpenViduRole = require('openvidu-node-client').OpenViduRole;

// Check launch arguments: must receive openvidu-server URL and the secret
if (process.argv.length != 4) {
    console.log("Usage: node " + __filename + " OPENVIDU_URL OPENVIDU_SECRET");
    process.exit(-1);
}
// For demo purposes we ignore self-signed certificate
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"

// Node imports
var express = require('express');
var fs = require('fs');
var session = require('express-session');
var https = require('https');
const axios = require('axios').default;
var bodyParser = require('body-parser'); // Pull information from HTML POST (express4)
var app = express(); // Create our app with express

// Server configuration
app.use(session({
    saveUninitialized: true,
    resave: false,
    secret: 'MY_SECRET'
}));
app.use(express.static(__dirname + '/public')); // Set the static files location
app.use(bodyParser.urlencoded({
    'extended': 'true'
})); // Parse application/x-www-form-urlencoded
app.use(bodyParser.json()); // Parse application/json
app.use(bodyParser.json({
    type: 'application/vnd.api+json'
})); // Parse application/vnd.api+json as json

// Listen (start app with node server.js)
var options = {
    key: fs.readFileSync('certificates/live/ikuz.dev/privkey.pem'),
    cert: fs.readFileSync('certificates/live/ikuz.dev/cert.pem')
};
https.createServer(options, app).listen(5442);

// Mock database
var users = [{
    user: "publisher1",
    pass: "pass",
    role: OpenViduRole.PUBLISHER
}, {
    user: "publisher2",
    pass: "pass",
    role: OpenViduRole.PUBLISHER
}, {
    user: "subscriber",
    pass: "pass",
    role: OpenViduRole.SUBSCRIBER
}];

// Environment variable: URL where our OpenVidu server is listening
var OPENVIDU_URL = process.argv[2];
// Environment variable: secret shared with our OpenVidu server
var OPENVIDU_SECRET = process.argv[3];

// Entrypoint to OpenVidu Node Client SDK
var OV = new OpenVidu(OPENVIDU_URL, OPENVIDU_SECRET);

// Collection to pair session names with OpenVidu Session objects
var mapSessions = {};
// Collection to pair session names with tokens
var mapSessionNamesTokens = {};

console.log("App listening on port 5442");

/* CONFIGURATION */



/* REST API */

// Login
app.post('/api-login/login', function (req, res) {
    req.session.loggedUser = req.body.user;
    res.status(200).send();
});

// Logout
app.post('/api-login/logout', function (req, res) {
    console.log("'" + req.session.loggedUser + "' has logged out");
    req.session.destroy();
    res.status(200).send();
});

// Get token (add new user to session)
app.post('/api-sessions/get-token', function (req, res) {
    if (!isLogged(req.session)) {
        req.session.destroy();
        res.status(401).send('User not logged');
    } else {
        // The video-call to connect
        var sessionName = req.body.sessionName;

        // Optional data to be passed to other users when this user connects to the video-call
        // In this case, a JSON with the value we stored in the req.session object on login
        var serverData = JSON.stringify({ serverData: req.session.loggedUser });

        console.log("Getting a token | {sessionName}={" + sessionName + "}");

        // Build connectionProperties object with the serverData and the role
        var connectionProperties = {
            data: serverData,
            role: OpenViduRole.PUBLISHER
        };

        if (mapSessions[sessionName]) {
            // Session already exists
            console.log('Existing session ' + sessionName);

            // Get the existing Session from the collection
            var mySession = mapSessions[sessionName];

            // Generate a new token asynchronously with the recently created connectionProperties
            mySession.createConnection(connectionProperties)
                .then(connection => {

                    // Store the new token in the collection of tokens
                    mapSessionNamesTokens[sessionName].push(connection.token);

                    // Return the token to the client
                    res.status(200).send({
                        0: connection.token
                    });
                })
                .catch(error => {
                    console.error(error);
                });
        } else {
            // New session
            console.log('New session ' + sessionName);

            // Create a new OpenVidu Session asynchronously
            OV.createSession()
                .then(session => {
                    // Store the new Session in the collection of Sessions
                    mapSessions[sessionName] = session;
                    // Store a new empty array in the collection of tokens
                    mapSessionNamesTokens[sessionName] = [];

                    // Generate a new connection asynchronously with the recently created connectionProperties
                    session.createConnection(connectionProperties)
                        .then(connection => {

                            // Store the new token in the collection of tokens
                            mapSessionNamesTokens[sessionName].push(connection.token);

                            // Return the Token to the client
                            res.status(200).send({
                                0: connection.token
                            });
                        })
                        .catch(error => {
                            console.error(error);
                        });
                })
                .catch(error => {
                    console.error(error);
                });
        }
    }
});

// Remove user from session
app.post('/api-sessions/remove-user', function (req, res) {
    if (!isLogged(req.session)) {
        req.session.destroy();
        res.status(401).send('User not logged');
    } else {
        // Retrieve params from POST body
        var sessionName = req.body.sessionName;
        var token = req.body.token;
        console.log('Removing user | {sessionName, token}={' + sessionName + ', ' + token + '}');

        // If the session exists
        if (mapSessions[sessionName] && mapSessionNamesTokens[sessionName]) {
            var tokens = mapSessionNamesTokens[sessionName];
            var index = tokens.indexOf(token);

            // If the token exists
            if (index !== -1) {
                // Token removed
                tokens.splice(index, 1);
                console.log(sessionName + ': ' + tokens.toString());
            } else {
                var msg = 'Problems in the app server: the TOKEN wasn\'t valid';
                console.log(msg);
                res.status(500).send(msg);
            }
            if (tokens.length == 0) {
                // Last user left: session must be removed
                console.log(sessionName + ' empty!');
                delete mapSessions[sessionName];
            }
            res.status(200).send();
        } else {
            var msg = 'Problems in the app server: the SESSION does not exist';
            console.log(msg);
            res.status(500).send(msg);
        }
    }
});

app.post('/api-sessions/send-data', function (req, res) {
    if (!isLogged(req.session)) {
        req.session.destroy();
        res.status(401).send('User not logged');
    } else {
        let sessionName = req.body.sessionName;
        let sessionId = req.body.sessionId;
        let receiverList = req.body.receiverList;
        let data = req.body.data;
        let translatedData = '';

        if (mapSessions[sessionName] && mapSessionNamesTokens[sessionName]) {
            const transapi = axios.create({
                baseURL: 'https://translate.api.cloud.yandex.net',
                headers: {
                    'Authorization': 'Bearer t1.9euelZqUjZfInMedm47Oz5vMyZTLyO3rnpWal46Sl86UzYuLnIrGl8bIyp3l8_dCHjh8-e9_aAtK_t3z9wJNNXz5739oC0r-.c08ekUkDxqclJ2Xr16m7C7Uy7fBqGz4jBBnTq8dnjhHib5Yfs4TCnBij3HN3xhExchPu3WWz9CfrNEZAhlPcBg',
                }
            });

            transapi
                .post('/translate/v2/detect', {
                    "text": data,
                    "folderId": "b1gug5odflske4af5d9i"
                })
                .then(function (response) {
                    // console.log(response);

                    let languageCode = response.data.languageCode;

                    transapi
                        .post('/translate/v2/translate', {
                            "sourceLanguageCode": languageCode,
                            "targetLanguageCode": "en",
                            "texts": [data],
                            "folderId": "b1gug5odflske4af5d9i"
                        })
                        .then(function (response) {
                            // console.log(response);

                            translatedData = response.data.translations[0].text;

                            const ovapi = axios.create({
                                baseURL: OV.host,
                                headers: {
                                    'Authorization': OV.basicAuth,
                                    'Content-Type': 'application/json'
                                }
                            });

                            ovapi
                                .post('/openvidu/api/signal', {
                                    session: sessionId,
                                    data: translatedData,
                                    to: receiverList,
                                    type: 'data-transfer'
                                })
                                .then(function (response) {
                                    // console.log(response);
                                })
                                .catch(function (error) {
                                    // console.log(error);
                                });
                        })
                        .catch(function (error) {
                            // console.log(error);
                        });
                })
                .catch(function (error) {
                    // console.log(error);
                });

            res.status(200).send();
        } else {
            var msg = 'Problems in the app server: the SESSION does not exist';
            console.log(msg);
            res.status(500).send(msg);
        }
    }
});

/* REST API */



/* AUXILIARY METHODS */

function isLogged(session) {
    return (session.loggedUser != null);
}

function getBasicAuth() {
    return 'Basic ' + (new Buffer('OPENVIDUAPP:' + OPENVIDU_SECRET).toString('base64'));
}

/* AUXILIARY METHODS */
