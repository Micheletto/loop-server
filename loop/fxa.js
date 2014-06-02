/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var https = require('https');
var conf = require('./config').conf;

// Don't be limited by the default node.js HTTP agent.
var agent = new https.Agent();
agent.maxSockets = 1000000;

// Be sure to use the exported verifier so we can mock it in the tests.
exports.verify = require('browserid-verify')({
  type: 'remote',
  agent: agent,
  url: conf.get('fxaVerifier')
});


/**
 * Express middleware doing BrowserID authentication.
 *
 * Checks the Authorization headers are set properly, and if not return
 * a 401 with according information.
 *
 * If the BrowserID assertion is parsed correctly, the user contained into this
 * one is set in the req.user property.
 */
function getMiddleware(audience, callback) {
  function requireBrowserID(req, res, next) {
    var authorization, assertion, policy, splitted;

    function _unauthorized(message){
      res.set('WWW-Authenticate', 'BrowserID');
      res.json(401, message || "Unauthorized");
    }

    authorization = req.headers.authorization;

    if (authorization === undefined) {
      _unauthorized();
      return;
    }

    splitted = authorization.split(" ");
    if (splitted.length !== 2) {
      _unauthorized();
      return;
    }

    policy = splitted[0];
    assertion = splitted[1];

    if (policy.toLowerCase() !== 'browserid') {
      _unauthorized("Unsupported");
      return;
    }

    exports.verify(assertion, audience,
      function(err, email, response) {
      if (err) {
        _unauthorized(err);
        return;
      }
      callback(req, res, response, next);
    });
  }

  return requireBrowserID;
}

exports.getMiddleware = getMiddleware;
