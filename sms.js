module.exports = function(RED) {
  "use strict";

  var http = require("follow-redirects").http;
  var uuid = require("uuid/v4");
  var mqtt = require("mqtt");
  var urllib = require("url");
  var Mustache = require("mustache");

  function sendSMS(n) {
    RED.nodes.createNode(this, n);

    this.text = n.text;
    this.to = n.to;
    this.protocol = n.protocol;

    var node = this;

    this.on('input', function(msg) {
      var text = node.text;
      var availableProperties = ["message", "text", "payload"]
      var propertyUsed = null;
      var cloneOfMsg = RED.util.cloneMessage(msg);
      if(!text){
        for( var i in availableProperties){
          if(msg.hasOwnProperty(availableProperties[i]) && msg[availableProperties[i]]){
            propertyUsed = availableProperties[i];
            break;
          }
        }
        if(propertyUsed === null){
          node.warn("Cannot send an empty payload");
          return;
        }
        text = msg[propertyUsed];
        delete cloneOfMsg[propertyUsed];
      }

      text = Mustache.render(text, cloneOfMsg);
      var to = msg.to || node.to;
      var protocol = msg.protocol || node.protocol || 'http';
      var notOk = false;
      var regexphone = /\+(9[976]\d|8[987530]\d|6[987]\d|5[90]\d|42\d|3[875]\d|2[98654321]\d|9[8543210]|8[6421]|6[6543210]|5[87654321]|4[987654310]|3[9643210]|2[70]|7|1)(\d{1,14})$/;
      if(!to.match(regexphone)){
        node.warn("wrong phone number, use international format, with no space or union. Ex:  +447321654321 ");
        notOk = true;
      }
      if(text == ""){
        node.warn("You have nothing to send, fill msg.text or msg.payload");
        notOk = true;
      }
      if(notOk){
        return;
      }

      function processAnswer(payload){
        var data = "";
        var err = false;
        try{
          payload = JSON.parse(payload);
        }catch(e){}
        var _payload = payload

        try{
          payload = JSON.parse(payload.payload);
        }catch(e){
          payload = payload.payload;
        }

        if(_payload.hasOwnProperty("error")){
            data = _payload.payload;
            err = true;
        } else if(payload.hasOwnProperty("needAccount")){
          data = "You need an account to use our services.";
          err = true;
        } else if(payload.hasOwnProperty("needActivation")){
          data = "You need to activate your account to use our services.";
          err = true;
        } else if(payload.statusCode == "2"){
          data = "SMS is not included in the subscription";
          err = true;
        } else{
          if(payload.statusCode == "1") {
            data = "Quota is exceeded\n";
            err = true;
          }

          if(payload.subInfos.conso % 1 == 0) {
            payload.subInfos.conso = parseInt(payload.subInfos.conso);
          }

          var outPackage = payload.subInfos.outPackage;

          if(outPackage.total % 1 == 0) {
            outPackage.total = parseInt(outPackage.total);
          }

          if(payload.subInfos.limit == "0") {
            data += "Vous avez une consommation de "+payload.subInfos.conso+" "+payload.subInfos.type+", pour une utilisation illimitée.";
          } else {
            data += "Vous avez une consommation de "+payload.subInfos.conso+" "+payload.subInfos.type+" pour une limite de "+payload.subInfos.limit+".";
          }

          if(typeof outPackage.unitPrice != "undefined") {
            data += "\nVous avez consommé "+outPackage.total+" "+payload.subInfos.type+" en hors forfait. Le prix unitaire en hors forfait est de : "+outPackage.unitPrice;
          }
        }

        return {
          payload: payload.subInfos || null,
          statusCode: payload.statusCode,
          message: data,
          warn: err
        }
      }

      function handle(data, err){
        var answer = {}
        if(err){
          node.warn(data)
          answer.warn = true
          answer.payload = data
          answer.statusCode = err.code
          answer.message = err.toString()
        } else {
          answer = processAnswer(data)
        }

        if(answer.warn){
          node.warn(answer.message);
        }

        msg.payload = answer.payload;
        msg.statusCode = answer.statusCode;
        msg.message = answer.message;
        node.send(msg);
      }

      switch(protocol){
        case 'http' :
          sendHTTP({
            "url": "http://mythingbox.io/api/services/sendsms",
            "payload":{
              "to":to,
              "payload":text
            }
          }, handle);
          break;
        case 'mqtt' :
          var msgid = uuid();
          sendMQTT({
            "topic": "api/services/sendsms/{{{ttb_id}}}/"+msgid,
            "backtopic": "receive/"+msgid,
            "payload":{
              "to":to,
              "payload":text
            }
          }, handle);
          break;
        default:
      }
    });
  }
  RED.nodes.registerType("sms-out", sendSMS);

  function sendHTTP(message, callback){
    var url = "http:///cloud";
    var opts = urllib.parse(url);
    var code;
    var payload;

    try{
      message = JSON.stringify(message);
    } catch(e){}

    opts.method = "POST";
    opts.headers = {};
    opts.headers['content-type'] = "application/json";
    opts.headers['content-length'] = Buffer.byteLength(message);

    var req = http.request(opts,function(res) {
      code = res.statusCode;
      payload = "";
      res.on('data',function(chunk) {
        payload += chunk;
      });
      res.on('end',function() {
        callback(payload)
      });
    });
    req.on('error',function(err) {
      callback(err.toString() + " : " + url, err)
    });
    req.write(message);
    req.end();
  }

  function sendMQTT(message, callback){
    var backtopic = message.backtopic
    try{
      message = JSON.stringify(message);
    } catch(e){}

    var client  = mqtt.connect("mqtt://mosquitto:1883");

    client.on('message', function (topic, payload) {
      if(topic === backtopic){
        callback(payload)
        client.end()
      }
    })

    client.on('connect', function () {
      client.subscribe(backtopic , 0, function(err, granted){
        if(!err){
          client.publish('cloud', message);
        }
      })
    })
  }
}
