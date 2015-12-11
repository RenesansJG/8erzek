// JavaScript Document
// interval: ennyi ms-onként kérdezik le a játékosok állapotát a játékosok
var interval = 5000;

var Game = Parse.Object.extend("Game");
var Player = Parse.Object.extend("Player");
var Round = Parse.Object.extend("Round");
var Answer = Parse.Object.extend("Answer");

function newPlayer(game, user, installation) {
    var player = new Player();
    player.set("game", game);
    player.set("user", user);
    player.set("installation", installation);
    player.set("heartbeat", 0);
    player.set("ready", false);
    return player.save().then(function(result) {
        var query = new Parse.Query(Player);
        query.include("game");
        query.include("user");
        return query.get(result.id);
    });
}

function newGame(user, installation, name, numPlayers, difficulty) {
    var game;
    var player;
    
    game = new Game();
    game.set("name", name);
    game.set("numPlayers", numPlayers);
    game.set("difficulty", difficulty);
    game.set("started", false);
    
    return game.save().then(function(result) {
        game = result;
        return newPlayer(game, user, installation);
    }).then(function(result) {
        player = result;
        return Parse.Promise.as([player]);
    });
}

function findPlayer(game, user, installation) {
    var query = new Parse.Query(Player);
    query.equalTo("game", game);
    query.equalTo("user", user);
    query.equalTo("installation", installation);
    query.include("user");
    return query.first();
}

function findPlayers(game) {
    var query = new Parse.Query(Player);
    query.equalTo("game", game);
    query.ascending("createdAt");
    query.include("game");
    query.include("user");
    return query.find();
}

function deleteInactivePlayers(players) {
    var inactivePlayers = [];
    var indicesOfInactivePlayers = [];
    var host = players[0];

    for (var i = 1; i < players.length; i++) {
        var player = players[i];
        /**
         * @param host.updatedAt
         */
        if (host.updatedAt.getTime() - player.updatedAt.getTime() > interval * 2) {
            inactivePlayers.push(player);
            indicesOfInactivePlayers.push(i);
        }
    }

    if (inactivePlayers.length > 0) {
        for (i = 0; i < indicesOfInactivePlayers.length; i++) {
            var index = indicesOfInactivePlayers[i];
            players.splice(index, 1);
        }
        
        var promise = Parse.Object.destroyAll(inactivePlayers);
    } else {
        promise = Parse.Promise.as(null);
    }
    
    return promise.then(function() {
        return Parse.Promise.as(players);
    });
}

function deletePlayerIfHostInactive(player, players) {
    if (player.updatedAt.getTime() - players[0].updatedAt.getTime() > interval * 2) {
        return player.destroy().then(function() {
            return Parse.Promise.as(null);
        });
    } else {
        return Parse.Promise.as(players);
    }
}

function heartbeat(game, user, installation) {
    var player;
    
    return findPlayer(game, user, installation).then(function(result) {
        if (typeof(result) === "undefined") {
            return newPlayer(game, user, installation);
        } else {
            result.increment("heartbeat");
            return result.save();
        }
    }).then(function(result) {
        player = result;
        return findPlayers(game);
    }).then(function(result) {
        if (player.id === result[0].id) {
            return deleteInactivePlayers(result);
        } else {
            return deletePlayerIfHostInactive(player, result);
        }
    });
}

/**
 * @param request.params.userId
 */
Parse.Cloud.define("heartbeat", function(request, response) {
    var user = new Parse.User();
    var installation = new Parse.Installation();
    
    user.id = request.params.userId;
    installation.id = request.params.installationId;
    
    var promise;
    
    if (request.params.gameId === null) {
        promise = newGame(user, installation, request.params.name, request.params.numPlayers,
            request.params.difficulty);
    } else {
        var game = new Game();
        game.id = request.params.gameId;
        promise = heartbeat(game, user, installation);
    }
    
    promise.then(function(result) {
        response.success(result);
    }, function() {
        response.error();
    });
});

function findRound(game, num) {
    var query = new Parse.Query(Round);
    query.equalTo("game", game);
    query.equalTo("num", num);
    query.ascending("createdAt");
    return query.first();
}

function getInstallationIds(players) {
    var installationIds = [];

    for (var i = 0; i < players.length; i++) {
        var installation = players[i].get("installation");
        installationIds.push(installation.id);
    }

    return installationIds;
}

function sendPush(players, player, data) {
    var installationIds = getInstallationIds(players);
    var installation = player.get("installation");

    var debugText = "players:";
    for (var i = 0; i < players.length; i++) {
        debugText += " " + players[i].id;
    }
    console.log(debugText);

    debugText = "installationIds:";
    for (i = 0; i < installationIds.length; i++) {
        debugText += " " + installationIds[i];
    }
    console.log(debugText);
    console.log("installationId of player: " + installation.id);

    var query = new Parse.Query(Parse.Installation);
    query.containedIn("objectId", installationIds);
    query.notEqualTo("objectId", installation.id);

    return Parse.Push.send({
        where: query,
        data: data
    });
}

function sendNewRoundPush(round, player) {
    return findPlayers(round.get("game")).then(function(result) {
        console.log("NUMBER OF PLAYERS: " + result.length);
        return sendPush(result, player, {
            event: "newRound",
            roundId: round.id,
            gameId: round.get("game").id,
            num: round.get("num"),
            question: round.get("question"),
            createdAt: round.createdAt.getTime(),
            serverTime: new Date().getTime()
        });
    });
}

function newRound(game, num, question, player) {
    var round = new Round();
    round.set("game", game);
    round.set("num", num);
    round.set("question", question);
    var round2;

    return round.save().then(function(result) {
        round = result;
        return findRound(game, num);
    }).then(function(result) {
        round2 = result;
        return player.fetch();
    }).then(function(result) {
        player = result;
        if (round2.id !== round.id) {
            return round.destroy();
        } else {

            console.log("CREATED NEW ROUND WITH GAME: " + game.id);

            return sendNewRoundPush(round2, player);
        }
    }).then(function() {
        return Parse.Promise.as(round2);
    });
}

/**
 * @param request.params.num
 * @param request.params.question
 */
Parse.Cloud.define("getRound", function(request, response) {
    console.log("GETROUND WITH GAME: " + request.params.gameId);

    var game = new Game();
    game.id = request.params.gameId;
    var player = new Player();
    player.id = request.params.playerId;
    
    findRound(game, request.params.num).then(function(result) {
        if (typeof(result) !== "undefined") {
            return Parse.Promise.as(result);
        } else {
            return newRound(game, request.params.num, request.params.question, player);
        }
    }).then(function(result) {
        response.success({round: result, time: new Date().getTime()});
    }, function() {
        response.error();
    });
});

function sendNewAnswerPush(answer, player) {
    var round = answer.get("round");
    return round.fetch().then(function(result) {
        round = result;
        return findPlayers(round.get("game"));
    }).then(function(result) {
        console.log("NUMBER OF PLAYERS: " + result.length);

        return sendPush(result, player, {
            event: "newAnswer",
            roundId: round.id,
            playerId: player.id,
            value: answer.get("value"),
            time: answer.get("time"),
            createdAt: answer.createdAt.getTime(),
            serverTime: new Date().getTime()
        })
    });
}

function newAnswer(round, player, value, time) {
    var answer = new Answer();
    answer.set("round", round);
    answer.set("player", player);
    answer.set("value", value);
    answer.set("time", time);
    return answer.save().then(function(result) {
        answer = result;
        return player.fetch();
    }).then(function(result) {
        player = result;
        return sendNewAnswerPush(answer, player);
    }).then(function() {
        return Parse.Promise.as(answer);
    });
}

/**
 * @param request.params.playerId
 */
Parse.Cloud.define("newAnswer", function(request, response) {
    var round = new Round();
    round.id = request.params.roundId;
    var player = new Player();
    player.id = request.params.playerId;

    newAnswer(round, player, request.params.value, request.params.time).then(function(result) {
        response.success({answer: result, time: new Date().getTime()});
    }, function() {
        response.error();
    });
});

/**
 * @param request.params.gameId
 */
Parse.Cloud.define("getCurrentRound", function(request, response) {
    var game = new Game();
    game.id = request.params.gameId;
    
    var query = new Parse.Query("Round");
    query.equalTo("game", game);
    query.addDescending("num");
    query.addAscending("createdAt");
    
    query.first().then(function(result) {
        response.success({round: result, time: new Date().getTime()});
    }, function() {
        response.error();
    });
});

/**
 * @param request.params.roundId
 */
Parse.Cloud.define("findAnswers", function(request, response) {
    var round = new Round();
    round.id = request.params.roundId;
    
    var query = new Parse.Query(Answer);
    query.equalTo("round", round);
    query.ascending("createdAt");
    
    query.find().then(function(result) {
        response.success({answers: result, time: new Date().getTime()});
    }, function() {
        response.error();
    });
});
