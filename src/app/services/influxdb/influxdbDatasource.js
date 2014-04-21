define([
  'angular',
  'underscore',
  'kbn'
],
function (angular, _, kbn) {
  'use strict';

  var module = angular.module('kibana.services');

  module.factory('InfluxDatasource', function($q, $http) {

    function InfluxDatasource(datasource) {
      this.type = 'influxDB';
      this.editorSrc = 'app/partials/influxdb/editor.html';
      this.urls = datasource.urls;
      this.username = datasource.username;
      this.password = datasource.password;
      this.name = datasource.name;

      this.templateSettings = {
        interpolate : /\[\[([\s\S]+?)\]\]/g,
      };
    }

    InfluxDatasource.prototype.query = function(options) {

      var promises = _.map(options.targets, function(target) {
        var query;

        if (target.hide || !((target.series && target.column) || target.query)) {
          return [];
        }

        var templateData = {
          series: target.series,
          column: target.column,
          func: target.function,
          condition: target.condition_joined,
          timeFilter: getTimeFilter(options),
          interval: target.interval || options.interval
        };

        var timeFilter = getTimeFilter(options);

        if (target.rawQuery) {
          query = target.query;
          query = query.replace(";", "");
          var queryElements = query.split(" ");
          var lowerCaseQueryElements = query.toLowerCase().split(" ");
          var whereIndex = lowerCaseQueryElements.indexOf("where");
          var groupByIndex = lowerCaseQueryElements.indexOf("group");
          var orderIndex = lowerCaseQueryElements.indexOf("order");

          if (whereIndex !== -1) {
            queryElements.splice(whereIndex+1, 0, timeFilter, "and");
          }
          else {
            if (groupByIndex !== -1) {
              queryElements.splice(groupByIndex, 0, "where", timeFilter);
            }
            else if (orderIndex !== -1) {
              queryElements.splice(orderIndex, 0, "where", timeFilter);
            }
            else {
              queryElements.push("where");
              queryElements.push(timeFilter);
            }
          }

          query = queryElements.join(" ");
        }
        else {
          var template = "select [[func]]([[column]]) as [[column]]_[[func]] from [[series]] " +
                         "where [[condition]] [[timeFilter]]" +
                         " group by time([[interval]]) order asc";

          target.condition_joined = (target.condition !== undefined ? target.condition + ' AND ' : '');

          var templateData = {
            series: target.series,
            column: target.column,
            func: target.function,
            timeFilter: timeFilter,
            interval: target.interval || options.interval
          };

          query = _.template(template, templateData, this.templateSettings);
          target.query = query;
        }

        return this.doInfluxRequest(query).then(handleInfluxQueryResponse);

      }, this);

      return $q.all(promises).then(function(results) {
        return { data: _.flatten(results) };
      });

    };

    InfluxDatasource.prototype.listColumns = function(seriesName) {
      return this.doInfluxRequest('select * from ' + seriesName + ' limit 1').then(function(data) {
        if (!data) {
          return [];
        }

        return data[0].columns;
      });
    };

    InfluxDatasource.prototype.listSeries = function() {
      return this.doInfluxRequest('list series').then(function(data) {
        return _.map(data, function(series) {
          return series.name;
        });
      });
    };

    function retry(deferred, callback, delay) {
      return callback().then(undefined, function(reason) {
        if (reason.status !== 0) {
          deferred.reject(reason);
        }
        setTimeout(function() {
          return retry(deferred, callback, Math.min(delay * 2, 30000));
        }, delay);
      });
    }

    InfluxDatasource.prototype.doInfluxRequest = function(query) {
      var _this = this;
      var deferred = $q.defer();

      retry(deferred, function() {
        var currentUrl = _this.urls.shift();
        _this.urls.push(currentUrl);

        var params = {
          u: _this.username,
          p: _this.password,
          q: query
        };

        var options = {
          method: 'GET',
          url:    currentUrl + '/series',
          params: params,
        };

        return $http(options).success(function (data) {
          deferred.resolve(data);
        });
      }, 10);

      return deferred.promise;
    };

    function handleInfluxQueryResponse(data) {
      var output = [];

      var getKey = function (str) {
        var key1 = str.split(' where ');
        var key2 = key1[1].split(' AND ');
        return (key2[0] !== key1[1] ? '.' + key2[0] : '');
      }

      _.each(data, function(series) {
        var timeCol = series.columns.indexOf('time');

        _.each(series.columns, function(column, index) {
          if (column === "time" || column === "sequence_number") {
            return;
          }

          console.log("series:"+series.name + ": "+series.points.length + " points");

          var target = series.name + "." + column + getKey(results.config.params.q);
          var datapoints = [];

          for(var i = 0; i < series.points.length; i++) {
            var t = Math.floor(series.points[i][timeCol] / 1000);
            var v = series.points[i][index];
            datapoints[i] = [v,t];
          }

          output.push({ target:target, datapoints:datapoints });
        });
      });

      return output;
    }

    function getTimeFilter(options) {
      var from = getInfluxTime(options.range.from);
      var until = getInfluxTime(options.range.to);

      if (until === 'now()') {
        return 'time > now() - ' + from;
      }

      return 'time > ' + from + ' and time < ' + until;
    }

    function getInfluxTime(date) {
      if (_.isString(date)) {
        if (date === 'now') {
          return 'now()';
        }
        else if (date.indexOf('now') >= 0) {
          return date.substring(4);
        }

        date = kbn.parseDate(date);
      }

      return to_utc_epoch_seconds(date);
    }

    function to_utc_epoch_seconds(date) {
      return (date.getTime() / 1000).toFixed(0) + 's';
    }


    return InfluxDatasource;

  });

});
