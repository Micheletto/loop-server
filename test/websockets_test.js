/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

var expect = require("chai").expect;
var sinon = require("sinon");
var crypto = require("crypto");

var ws = require('ws');

var Token = require("../loop/token").Token;
var tokenlib = require("../loop/tokenlib");

var loop = require("../loop");
var server = loop.server;
var storage = loop.storage;
var conf = loop.conf;


describe('websockets', function() {
  var client, hawkCredentials, userHmac, sandbox;

  beforeEach(function(done) {
    sandbox = sinon.sandbox.create();

    // Create the websocket client.
    client = new ws("ws://localhost:" + server.address().port);

    // Generate Hawk credentials.
    var token = new Token();
    token.getCredentials(function(tokenId, authKey) {
      hawkCredentials = {
        id: tokenId,
        key: authKey,
        algorithm: "sha256"
      };
      userHmac = tokenId;
      storage.setHawkSession(tokenId, authKey, done);
    });
  });

  afterEach(function(done) {
    sandbox.restore();
    client.on('close', function() { done(); });
    client.close();
  });

  it('should listen on the same port the app does', function(done) {
    client.on('open', function() {
      done();
    });
  });

  it('should reject bad authentication tokens', function(done) {
    client.on('open', function() {
      client.on('message', function(data) {
        var error = JSON.parse(data);
        expect(error.messageType).eql('error');
        expect(error.reason).eql('bad authentication');
        done();
      });
      client.send(JSON.stringify({
        messageType: 'hello',
        auth: '1234',
        callId: '1234'
      }));
    });
  });

  it('should reject an invalid callId with a valid hawk session',
    function(done) {
      client.on('open', function() {
        client.on('message', function(data) {
          var error = JSON.parse(data);
          expect(error.messageType).eql('error');
          expect(error.reason).eql('bad callId');
          done();
        });

        client.send(JSON.stringify({
          messageType: 'hello',
          auth: hawkCredentials.id,
          callId: '1234'
        }));
      });
    });

  it('should accept callers authenticating with the token url', function(done) {
    var tokenManager = new tokenlib.TokenManager({
      macSecret: conf.get('macSecret'),
      encryptionSecret: conf.get('encryptionSecret')
    });
    var token = tokenManager.encode({
      uuid: '1234',
      user: hawkCredentials.id,
      callerId: 'Alexis'
    });
    var currentTimestamp = Date.now();
    var callId = crypto.randomBytes(16).toString('hex');

    client.on('open', function() {
      storage.addUserCall(hawkCredentials.id, {
        'callerId': 'Alexis',
        'callId': callId,
        'userMac': hawkCredentials.id,
        'sessionId': '1234',
        'calleeToken': '1234',
        'timestamp': currentTimestamp
      }, function(err) {
        if (err) throw err;
        storage.setCallState(callId, "init", function(err) {
          if (err) throw err;
          client.on('message', function(data) {
            var message = JSON.parse(data);
            expect(message.messageType).eql("hello");
            expect(message.state).eql("init");
            done();
          });

          client.send(JSON.stringify({
            messageType: 'hello',
            auth: token,
            callId: callId
          }));
        });
      });
    });
  });

  it('should return the state of the call', function(done) {
    var currentTimestamp = Date.now();
    var callId = crypto.randomBytes(16).toString('hex');

    client.on('open', function() {
      storage.addUserCall(hawkCredentials.id, {
        'callerId': 'Remy',
        'callId': callId,
        'userMac': hawkCredentials.id,
        'sessionId': '1234',
        'calleeToken': '1234',
        'timestamp': currentTimestamp
      }, function(err) {
        if (err) throw err;
        storage.setCallState(callId, "init", function(err) {
          if (err) throw err;
          client.on('message', function(data) {
            var message = JSON.parse(data);
            expect(message.messageType).eql("hello");
            expect(message.state).eql("init");
            done();
          });

          client.send(JSON.stringify({
            messageType: 'hello',
            auth: hawkCredentials.id,
            callId: callId
          }));
        });
      });
    });
  });

  it('should broadcast call state to other interested parties', function() {});
});
