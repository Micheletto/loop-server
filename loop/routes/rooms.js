/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

var errors = require('../errno.json');
var sendError = require('../utils').sendError;
var tokenlib = require('../tokenlib');


/* eslint-disable */

module.exports = function (apiRouter, conf, logError, storage, auth,
                           validators, tokBox) {
  var roomsConf = conf.get("rooms");

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
    validators.validateRoomUrlParams, function(req, res) {
      var token = tokenlib.generateToken(conf.get("rooms").tokenSize);
      var now = parseInt(Date.now() / 1000, 10);
      req.roomData.creationTime = now;
      req.roomData.expiresAt = now + req.roomData.expiresIn * tokenlib.ONE_HOUR;

      tokBox.getSession(function(err, session) {
        if (res.serverError(err)) return;

        req.roomData.sessionId = session.sessionId;

        storage.addUserRoomData(req.user, token, req.roomData, function(err) {
          if (res.serverError(err)) return;

          res.status(201).json({
            roomToken: token,
            roomUrl: roomsConf.webAppUrl.replace('{token}', token),
            expiresAt: req.roomData.expiresAt
          });
        });
      });
    });

  /**
   * PUT /rooms/{id}
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
  apiRouter.put('/rooms/:token', function(req, res) {

  });

  apiRouter.delete('/rooms/:token', validators.validateRoomToken,
    function(req, res) {
      storage.deleteRoomData(req.token, function(err) {
        if (res.serverError(err)) return;
        res.status(204).json({});
      });
    });

  apiRouter.get('/rooms/:token', validators.validateRoomToken, function(req, res) {
    var clientMaxSize = req.roomData.maxSize;
    var participants = [];

    res.status(200).json({
      roomName: req.roomData.roomName,
      roomOwner: req.roomData.roomOwner,
      maxSize: req.roomData.maxSize,
      clientMaxSize: clientMaxSize,
      creationTime: req.roomData.creationTime,
      expiresAt: req.roomData.expiresAt,
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
  apiRouter.post('/rooms/:token', function(req, res) {

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

  apiRouter.get('/rooms', function(req, res) {

  });
};
/* eslint-enable */
