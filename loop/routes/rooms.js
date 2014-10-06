/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

var errors = require('../errno.json');
var sendError = require('../utils').sendError;
var tokenlib = require('../tokenlib');
var uuid = require('node-uuid');
var request = require('request');

/* eslint-disable */

module.exports = function (apiRouter, conf, logError, storage, auth,
                           validators, tokBox) {
  var roomsConf = conf.get("rooms");


  /**
   * Returns the maximum number of allowed participants, between a list of
   * participants and the maximum size of a room.
   *
   * @param {Array} participants, the list of participants. Each participant
   *                object should contain a "clientMaxSize" property.
   * @param {Number} roomMaxSize, the maximum size of the room.
   **/
  function getClientMaxSize(participants, roomMaxSize) {
    var clientMaxSize = Math.min.apply(Math, participants.map(
      function(participant) {
        return participant.clientMaxSize;
      }));
    return Math.min(clientMaxSize, roomMaxSize);
  }


  /**
   * Ping the room Owner simplePush rooms endpoints
   **/
  function notifyOwner(roomOwnerHmac, version, callback) {
    storage.getUserSimplePushURLs(roomOwnerHmac,
      function(err, simplePushURLsMapping) {
        if (err) {
          callback(err);
          return;
        }
        simplePushURLsMapping.rooms.forEach(function(simplePushUrl) {
          request.put({
            url: simplePushUrl,
            form: { version: version }
          }, function() {
            // Catch errors.
          });
        });
        callback(null);
      });
  }

  /**
   * Emit an event on a room and trigger the following process:
   *  - Update the room ctime
   *  - Ping the room Owner simplePush rooms endpoints
   *
   * @param roomToken The roomToken
   * @param userIdHmac The roomOwnerHmac
   * @param callback The action to do next
   **/
  function emitRoomEvent(roomToken, roomOwnerHmac, callback) {
    storage.touchRoomData(roomToken, function(err, version) {
      if (err) {
        callback(err);
        return;
      }
      notifyOwner(roomOwnerHmac, version, callback);
    });
  }

  /**
   * Room creation.
   *
   * accepts
   *   roomName - The room-owner-assigned name used to identify this room.
   *   expiresIn - The number of hours for which the room will exist.
   *   roomOwner - The user-friendly display name indicating the name of the room's owner.
   *   maxSize - The maximum number of users allowed in the room at one time.

   * returns
   *   roomToken - The token used to identify this room.
   *   roomUrl - A URL that can be given to other users to allow them to join the room.
   *   expiresAt - The date after which the room will no longer be valid (in seconds since the Unix epoch).
   *
   **/
  apiRouter.post('/rooms', auth.requireHawkSession,
    validators.requireParams('roomName', 'roomOwner', 'maxSize'),
    validators.validateRoomUrlParams, function(req, res) {
      var roomData = req.roomRequestData;
      var token = tokenlib.generateToken(roomsConf.tokenSize);
      var now = parseInt(Date.now() / 1000, 10);
      roomData.creationTime = now;
      roomData.updateTime = now;
      roomData.expiresAt = now + roomData.expiresIn * tokenlib.ONE_HOUR;
      roomData.roomOwnerHmac = req.user;

      tokBox.getSession(function(err, session, opentok) {
        if (res.serverError(err)) return;

        roomData.sessionId = session.sessionId;
        roomData.apiKey = opentok.apiKey;

        storage.setUserRoomData(req.user, token, roomData, function(err) {
          if (res.serverError(err)) return;
          notifyOwner(req.user, roomData.updateTime, function(err) {
            if (res.serverError(err)) return;
            res.status(201).json({
              roomToken: token,
              roomUrl: roomsConf.webAppUrl.replace('{token}', token),
              expiresAt: roomData.expiresAt
            });
          });
        });
      });
    });

  /**
   * PATCH /rooms/{id}
   *
   * accepts:
   * roomName - The room-owner-assigned name used to identify this room.
   * expiresIn - The number of hours for which the room will exist.
   * roomOwner - The user-friendly display name indicating the name of the
                 room's owner.
   * maxSize - The maximum number of users allowed in the room at one time.
   *
   * returns
   * expiresAt - The date after which the room will no longer be valid (in
   * seconds since the Unix epoch).
   **/
  apiRouter.patch('/rooms/:token', auth.requireHawkSession,
    validators.validateRoomToken, validators.validateRoomUrlParams,
    validators.isRoomOwner, function(req, res) {
      var now = parseInt(Date.now() / 1000, 10);
      var roomData = req.roomStorageData;

      roomData.updateTime = now;

      // Update the object with new data
      Object.keys(req.roomRequestData).map(function(key) {
        roomData[key] = req.roomRequestData[key];
      });

      roomData.expiresAt = now + roomData.expiresIn * tokenlib.ONE_HOUR;

      storage.setUserRoomData(req.user, req.token, roomData, function(err) {
        if (res.serverError(err)) return;
        notifyOwner(req.user, now, function(err) {
          if (res.serverError(err)) return;
          res.status(200).json({
            expiresAt: roomData.expiresAt
          });
        });
      });
    });

  apiRouter.delete('/rooms/:token', auth.requireHawkSession,
    validators.validateRoomToken, validators.isRoomOwner,
    function(req, res) {
      storage.deleteRoomData(req.token, function(err) {
        if (res.serverError(err)) return;
        var now = parseInt(Date.now() / 1000, 10);
        notifyOwner(req.user, now, function(err) {
          if (res.serverError(err)) return;
          res.status(204).json({});
        });
      });
    });

  apiRouter.get('/rooms/:token', auth.requireHawkSession,
    validators.validateRoomToken, validators.isRoomParticipant,
    function(req, res) {
      var participants = req.roomStorageData.participants;
      var clientMaxSize = getClientMaxSize(
        participants,
        req.roomStorageData.maxSize
      );

      res.status(200).json({
        roomName: req.roomStorageData.roomName,
        roomOwner: req.roomStorageData.roomOwner,
        maxSize: req.roomStorageData.maxSize,
        clientMaxSize: clientMaxSize,
        creationTime: req.roomStorageData.creationTime,
        expiresAt: req.roomStorageData.expiresAt,
        ctime: req.roomStorageData.updateTime,
        participants: participants
      });
    });

  /**
   * action - "join", "leave", "refresh".
   *
   * For join, accepts:
   * displayName - User-friendly display name for the joining user.
   * clientMaxSize - Maximum number of room participants the user's client is capable of supporting.
   **/
  apiRouter.post('/rooms/:token', auth.requireHawkSession,
    validators.validateRoomToken, function(req, res) {
      var ROOM_ACTIONS = ["join", "refresh", "leave"];
      var action = req.body.action;
      var code;

      if (ROOM_ACTIONS.indexOf(action) === -1) {
        if (req.body.hasOwnProperty('action')) {
          code = errors.INVALID_PARAMETERS;
        } else {
          code = errors.MISSING_PARAMETERS;
        }
        sendError(res, 400, code,
                  "action should be one of " + ROOM_ACTIONS.join(", "));
        return;
      }

      var handlers = {
        handleJoin: function(req, res) {
          validators.requireParams('displayName', 'clientMaxSize')
            (req, res, function() {
              var requestMaxSize = parseInt(req.body.clientMaxSize, 10);
              if (requestMaxSize === NaN) {
                sendError(res, 400, errors.INVALID_PARAMETERS,
                          "clientMaxSize should be a number.");
                return;
              }
              var ttl = roomsConf.participantTTL;
              var sessionToken = tokBox.getSessionToken(
                req.roomStorageData.sessionId
              );
              storage.getRoomParticipants(req.token, function(err, participants) {
                if (res.serverError(err)) return;
                var clientMaxSize = getClientMaxSize(
                  participants,
                  req.roomStorageData.maxSize
                );

                if (clientMaxSize <= participants.length) {
                  // The room is already full.
                  sendError(res, 400, errors.ROOM_FULL,
                            "The room is full.");
                  return;
                } else if (requestMaxSize <= participants.length) {
                  // You cannot handle the number of actual participants.
                  sendError(res, 400, errors.CLIENT_REACHED_CAPACITY,
                    "Too many participants in the room for you to handle.");
                  return;
                }

                storage.addRoomParticipant(req.token, req.hawkIdHmac, {
                  id: uuid.v4(),
                  displayName: req.body.displayName,
                  clientMaxSize: requestMaxSize,
                  userIdHmac: req.user
                }, ttl, function(err) {
                  if (res.serverError(err)) return;
                  emitRoomEvent(req.token, req.roomStorageData.roomOwnerHmac,
                    function(err) {
                      if (res.serverError(err)) return;
                      res.status(200).json({
                        apiKey: req.roomStorageData.apiKey,
                        sessionId: req.roomStorageData.sessionId,
                        sessionToken: sessionToken,
                        expires: ttl
                      });
                    });
                });
              });
          });
        },
        handleRefresh: function(req, res) {
          var ttl = roomsConf.participantTTL;
          storage.touchRoomParticipant(req.token, req.hawkIdHmac, ttl,
            function(err, success) {
              if (res.serverError(err)) return;
              if (success !== true) {
                sendError(res, 410, errors.EXPIRED, "Participation has expired.");
                return;
              }
              res.status(200).json({
                expires: ttl
              });
            });
        },
        handleLeave: function(req, res) {
          storage.deleteRoomParticipant(req.token, req.hawkIdHmac,
            function(err) {
              if (res.serverError(err)) return;
              emitRoomEvent(req.token, req.roomStorageData.roomOwnerHmac,
                function(err) {
                  if (res.serverError(err)) return;
                  res.status(204).json();
                });
            });
        }
      };

      if (action == "join") {
        handlers.handleJoin(req, res);
      } else if (action == "refresh") {
        handlers.handleRefresh(req, res);
      } else if (action == "leave") {
        handlers.handleLeave(req, res);
      }
    });

  /**
   * returns:
   *
   * roomToken - The token that uniquely identifies this room
   * roomName - The room-owner-assigned name used to identify this room
   * maxSize - The maximum number of users allowed in the room at one time
   *           (as configured by the room owner).
   * clientMaxSize - The current maximum number of users allowed in the room,
   *                 as constrained by the clients currently participating in
   *                 the session. If no client has a supported size smaller
   *                 than "maxSize", then this will be equal to "maxSize".
   *                 Under no circumstances can "clientMaxSize" be larger than
   *                 "maxSize".
   * currSize - The number of users currently in the room
   * ctime - Similar in spirit to the Unix filesystem "ctime" (change time)
   *         attribute. The time, in seconds since the Unix epoch, that any
   *         of the following happened to the room:
   * - The room was created
   * - The owner modified its attributes with "PUT /room-url/{token}"
   * - A user joined the room
   * - A user left the room
  **/

  apiRouter.get('/rooms', auth.requireHawkSession, function(req, res) {
    var version = req.query.version;
    storage.getUserRooms(req.user, function(err, rooms) {
      if (res.serverError(err)) return;
      var roomsData = rooms.map(function(room) {
        if (version && room.updateTime < version) {
          return null;
        }
        return {
          roomToken: room.roomToken,
          roomName: room.roomName,
          maxSize: room.maxSize,
          currSize: room.currSize,
          ctime: room.updateTime
        };
      }).filter(function(room) {
        return room !== null;
      });
      res.status(200).json(roomsData);
    });
  });
};
/* eslint-enable */
