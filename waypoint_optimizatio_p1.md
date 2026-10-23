# Calculate Route | Routing API (Orbis v3)

## Purpose

The Calculate Route service calculates a route between an origin and a destination, passing through waypoints if they are specified.

*   The route will take into account factors such as current traffic and the typical road speeds on the requested day of the week and time of day.
*   Information returned includes the distance, estimated travel duration, and a representation of the route geometry.

### Run this endpoint

You can easily run this endpoint. Go to the TomTom [Routing API Playground](https://docs.tomtom.com/demos/routing-api-playground/) page and follow the directions.

## Request data

### HTTPS method: `POST`

Constants and parameters enclosed in curly brackets { } **must be replaced** with their values.

#### Generic request format

post

Generic request example

```
https://{baseURL}/maps/orbis/routing/routes/calculate?apiVersion={integer}
```

#### POST URL example

post

POST request URL example

```
https://api.tomtom.com/maps/orbis/routing/routes/calculate?apiVersion=3
```

#### POST curl command example

post

POST request curl command example

```
curl -X POST "https://api.tomtom.com/maps/orbis/routing/routes/calculate" -H "Content-Type:application/json" -H "TomTom-Api-Version:3" -H "TomTom-Api-Key:{Your_API_Key}" -H "Attributes:routes" -d \'{  "routePlanningLocations": {    "origin": {      "type": "Point",      "coordinates": [13.42936, 52.50931]    },    "destination": {      "type": "Point",      "coordinates": [13.43872, 52.50274]    }  },  "vehicleEngineType": "electric",  "path": {    "type": "LineString",    "coordinates": [      [13.42936, 52.5093],      [13.42859, 52.50844]    ]  },  "routeType": "short"}'
```

#### POST curl command example with entry points

post

Request curl command with entry points

```
curl -X POST "https://api.tomtom.com/maps/orbis/routing/routes/calculate" -H "Content-Type:application/json" -H "TomTom-Api-Version:3" -H "TomTom-Api-Key:{Your_API_Key}" -H "Attributes:routes" -d \'{  "routePlanningLocations": {    "origin": {      "type": "Point",      "coordinates": [13.626480, 52.328416]    },    "destination": {      "type": "Point",      "coordinates": [13.508614, 52.36428]    }  },  "legs" : [    {      "routeStop": {        "entryPoints": {          "type": "MultiPoint",          "coordinates": [            [13.50929, 52.36443],            [13.51781, 52.38909],            [13.52149, 52.37038],            [13.51031, 52.36281]          ]        },        "preferredEntryPointIndex": 0      }    }  ]}'
```

### Types

The following data table describes the types that can be used in the Calculate Route service.

Type

Description

`location` *string*

Latitude, longitude pair (in [EPSG:4326](https://spatialreference.org/ref/epsg/4326/) projection), with the following constraints:

*   Latitude values must be in the range `[-90, +90]`.
    
*   Longitude values must be in the range `[-180, +180]`.
    

Example: `52.37245,4.89406`

`point` *object*

A `location` represented as a JSON object. The object should contain the two fields `latitude` and `longitude` each containing a number, and expressed in the same reference frame and with the same constraints as for the `location` type. Example: `{“latitude”: 52.37245, “longitude”: 4.89406}`

`dateTime` *string*

A date and time specified in [RFC 3339](https://tools.ietf.org/html/rfc3339) format with an optional time zone offset. Examples:

*   `2023-12-19T16:39:57`
*   `2023-12-19T16:39:57-08:00`

#### Avoids parameter possible values

Value

Description

`tollRoads`

Avoids toll roads.

`motorways`

Avoids motorways.

**Note:** Avoiding motorways for long routes of approximately 500km+ may result in computation timeouts of the primary route or path alternatives.

`ferries`

Avoids ferries.

`unpavedRoads`

Avoids unpaved roads.

`carpools`

Avoids routes that require use of carpool (HOV/High Occupancy Vehicle) lanes.

`alreadyUsedRoads`

Avoids using the same road multiple times.  
This is most useful in conjunction with `routeType=thrilling`.

`borderCrossings`

Avoids crossing country borders.

`tunnels`

Avoids tunnels.

`carTrains`

Avoids car trains.

The following data table describes supported HTTP request headers.

*   Required headers must be used or the call will fail.
*   Optional headers may be used.
*   The order of request headers is not important.

Required headers

Description

TomTom-Api-Key

Authorization key to access the API. Value: Your valid `API Key`.

Attributes

Specifies which response fields to include using dot-notation. Fields marked as EXPLICIT in the response documentation must be explicitly listed in this header to be included in the response. See the [Response field selection](#response-field-selection) section for details and examples.

[Content-Type](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Type)

Specifies the MIME type of the body of the request. Value: `application/json`

Optional headers

Description

TomTom-Api-Version

Specifies API version  
Value: `3`

**

Note: this header is required if the query parameter `apiVersion` is not provided. This header will be ignored if the query parameter `apiVersion` is provided.

**

[Accept](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Accept)

Specifies the MIME type of the body of the response.  
Default value and only allowed value: `application/json`

[Accept-Encoding](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Accept-Encoding)

Requests that the response be compressed. Value: `gzip`

[Content-Encoding](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Encoding)

Specifies the compression used for the request body. Currently, only `gzip` is supported. If not specified, no compression is assumed. This is equal to specifying `identity`.

**

Note: This header is optional.

**

Values:

*   `identity`
*   `gzip`

Tracking-ID

Specifies an identifier for the request.

*   The value should be unique for each request.
    
*   The value must match the regular expression `’^[a-zA-Z0-9-_\.]{1,100}$’`.
    
*   If specified, the same value is sent back in the similar-named response header. Otherwise, a generated value may be sent back.
    

Attributes-Exclude

Specifies which response fields to exclude using dot-notation. The exclusion is applied after the inclusion list and overrides it. See the [Response field selection](#response-field-selection) section for details and examples.

[Accept-Language](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Accept-Language)

Determines the language of the returned names of places and phonetic translations in guidance.

*   Proper nouns (the names of streets, plazas, etc.) are returned in the specified language, or if that is not available, they are returned in an available language that is close to it.
    
*   The currently supported languages are listed in the [Supported Languages](https://docs.tomtom.com/routing-api/documentation/tomtom-orbis-maps/v3/supported-languages) page.
    

If the selected language isn’t supported, `en-GB` is used instead.

### Base path parameters

The following table describes the parameters that can be used in the Calculate Route service.

*   Required parameters **must be used** or the call will fail.
*   The order of the required parameters is important and must be followed.
*   There are no optional parameters.

Required parameters (Base path)

Description

`baseURL` *string*

Base URL for calling the API.  
Value: `api.tomtom.com` (The default global API endpoint.)

### Request parameters

The following table describes the parameters that can be used in the Calculate Route service.

*   Required parameters **must be used** or the call will fail.
*   Optional parameters may be used.
*   The order of the optional request parameters is not important.

Required parameters

Description

`apiVersion`  
*integer*

Specifies the API version.  
Only allowed value: `3`

**

Note: This parameter is not required if the header `TomTom-Api-Version` is provided.

**

### POST data parameters

The `path` field, which represents a polyline using GeoJSON format, is used to reconstruct a route. This route is then used as a reference route for route reassessment, or calculating zero or more alternative routes.

*   There are two options how to pass these polyline representations: for the entire route or per leg.
*   The provided polyline is used as input for route reconstruction.
*   The origin and destination points are expected to be at (or very near) the beginning and end of the reference route, respectively.

The following tables describe the required and optional POST data parameters, respectively:

Required parameters

Description

`routePlanningLocations`  
*RoutePlanningLocations* object

Locations through which the route is calculated.  
Contains fields `origin` and `destination`, and may contain field `waypoints`.  
For the details, please see the [RoutePlanningLocations](#routeplanninglocations) section.

Optional parameters

Description

`departureDateTime`  
*string*

The date and time of departure from the origin point.

*   Departure times apart from `now` must be specified as a `dateTime`.
    
*   When a time zone offset is not specified, it is assumed to be that of the origin point.
    
*   The `departureDateTime` parameter cannot be used in conjunction with `arrivalDateTime`.
    

Default value: `now`  
Other value: `dateTime`

`arrivalDateTime`  
*string*

The date and time of arrival at the destination point.

*   It must be specified as a `dateTime`.
    
*   When a time zone offset is not specified, it is assumed to be that of the destination point.
    

The `arrivalDateTime` parameter cannot be used in conjunction with:

*   `departureDateTime`

Value: `dateTime`

`avoids` *array*

Specifies something that the route calculation should try to avoid when determining the route. It can contain one or more possible values listed under [Avoids parameter possible values](#avoids-parameter-possible-values) and provided as an array of strings. If specified, the array must not be empty. Avoid values are applied to all route legs. Must not be used together with per-leg `avoids` parameter. Must be omitted if not needed.

`avoidAreas`

*object*

Defines areas of certain shapes that should be avoided when planning routes. Supported shapes include `rectangles`. It can contain one of each supported shapes fields.

`rectangles`

*array*

This is an array of GeoJSON Feature objects with a maximum of ten elements. Each object describes an axis-aligned rectangle.  
Each element **must** contain the fields `type`, `bbox` and `geometry` and must not contain any additional fields.

*   The maximum size of a rectangle is about 160x160 km.
    
*   It cannot cross the 180th meridian.
    
*   It must be between -80 and +80 degrees of latitude.
    

`type`

*string*

**Must** have the value `Feature`

`bbox`

*array*

Represents the area of the rectangle to be avoided. The array **must** contain exactly 4 numbers.  
The first two numbers represent the longitude and latitude (in that order) of the south west corner.  
The following two numbers represent the longitude and latitude (in that order) of the north east corner.  
`[southWestLongitude, southWestLatitude, northEastLongitude, northEastLatitude]`

`geometry`  
*object*

**Must** be null.

`path`  
A GeoJSON object of type `LineString`

Locations to be used as input for route reconstruction.

*   The specified `GeoJSON` object **must** contain only the following 2 fields: `type` and `coordinates`.
    
*   The `type` field **must** have the value `LineString`.
    
*   The `coordinates` field **must** be an array of GeoJSON positions. Each element of the array represents one point of the input route and is represented as an array of exactly 2 numbers: `[longitude, latitude]`.
    
*   The `coordinates` array must have at least 2 elements.
    

For more information on representing route geometry formats, see the [GeoJSON format](#geojson-format) section.

`legs`  
*array*

An array of objects with the parameters for the computation of each leg. If the parameter is such that it is available for use in the query parameters, then its simultaneous use in the query parameters and in the POST data is prohibited, and such a request will be returned with an error.  
If the `legs` field is present in the POST data, then the number of elements in the array must be equal to the number of `waypoints + 1`.  
If there is no need to specify any parameters for some leg, then an empty object must be specified.  
It may contain the following fields:

*   `routeType`: specifies the type of optimization used when calculating the leg. For the details, please see the [Request parameters](#request-parameters) section.  
    Default value: `fast`
    
*   `routeStop`: an object of RouteStop type with additional parameters for the stop at the end of the current leg. It must be omitted if not needed.
    
*   `path`: A GeoJSON object of type `LineString`, to be used as input for leg reconstruction.  
    `path` cannot be used for the entire route and per leg simultaneously.  
    The `coordinates` array inside the `path` must cover the whole leg, and the itinerary points (an origin, a destination, or a waypoint) must be located at (or very near to) the first and last points.  
    `path` parameter must be omitted if not needed.  
    When `path` is specified, the `coordinates` array in it must have at least two elements.  
    For more information on the GeoJSON format, see the [GeoJSON format](#geojson-format) section.
    
*   `avoids`: An array of objects of type [Route avoid](#route-avoid). Must be omitted if not needed. Must not be used together with the route-level POST parameter `avoids`.
    

`vehicleHeadingInDegrees` *integer*

The directional heading of the vehicle, in degrees starting at true North and continuing in a clockwise direction.

*   North is 0 degrees.
    
*   East is 90 degrees.
    
*   South is 180 degrees.
    
*   West is 270 degrees.
    

**Maximum value:** `359`  
**Other values:** `0-359`

`vehicleHasElectronicTollCollectionTransponder` *string*

Specifies that the route calculation should try to avoid ETC-transponder-only toll roads when determining the route if a vehicle does not have an ETC transponder. Possible values are:

*   `all`: Do not avoid ETC-transponder-only toll roads.
*   `none`: Avoids ETC-transponder-only toll roads.

Default value: `all`

`vehicleMaxSpeedInKilometersPerHour`  
*integer*

Maximum speed of the vehicle in kilometers/hour.

*   Must have a value in the range `[0, 250]`.
    
*   A value of `0` means that an appropriate value for the vehicle will be determined and applied during route planning.
    

Default value: `0`

`vehicleWeightInKilograms`  
*integer*

Weight of the vehicle in kilograms.  
When the value is positive then the calculated route respects weight restrictions.  
Default value: `0`  
Minimum value: `0`

`maxPathAlternativeRoutes`  
*integer*

Number of desired path alternative routes to be calculated. The value provided:

*   Must be an integer in the range 0-5.
    
*   Fewer path alternative routes may be returned if either fewer path alternatives exist, or the requested number of path alternatives is larger than the service can calculate.
    

**Default value:** `0`  
**Maximum value:** `5`

`traffic` *string*

Decides how traffic is considered for computing routes.  
Possible values are:

*   `live`: In addition to historical travel durations, routing and estimated travel durations consider traffic jams and short- and long-term closures during the travel time window.
    
*   `historical`: Routing and estimated travel duration consider historical travel durations and long term closures. Traffic jams and short-term closures during the travel time window do not influence routing or travel duration.
    

Default value: `live`

`routeType` *string*

Specifies the type of optimization used when calculating routes. Possible values are:

*   `fast`: Route calculation is optimized by travel duration, while keeping the routes sensible. For example, the calculation may avoid shortcuts along inconvenient side roads or long detours that only save very little time.
    
*   `short`: Route calculation is optimized such that a good compromise between small travel duration and short travel distance is achieved.
    
    *   Use `short` only for short to medium-distance routes. It explores a much larger search space than `fast`, so on long-distance routes — especially when combined with waypoints or `avoid` options — it can exceed the server’s compute time limit and the request will fail with a timeout. For long-distance planning, use `fast` instead. See the FAQ entry [How can I reduce the response time?](https://docs.tomtom.com/routing-api/documentation/tomtom-orbis-maps/v3/product-information/faq) for the full list of parameters that increase compute time.
        
*   `efficient`: Route calculation is optimized such that a good compromise between small travel duration and low fuel or energy consumption is achieved.
    
*   `thrilling`: Route calculation is optimized such that routes include interesting or challenging roads and use as few motorways as possible.
    
    *   There is a limit of 900km on routes planned with `routeType=thrilling`.
        

Default value: `fast`

`travelMode` *string*

The mode of travel to calculate the route.

Note that travel mode `taxi` is in BETA functionality. Full restriction data is not available in all areas.

Default value: `car`

Other value: `taxi`

`vehicleEngineType` *string*

The engine type of the vehicle. Default value: `combustion` Other value: `electric`

`arrivalSidePreference` *string*

Specifies the preference of roadside on arrival to waypoints and destination. Stop on the road has to be set at least two meters to the preferred side, otherwise the behavior will default to `anySide`. Possible values are:

*   `anySide`: Both sides of a road could be used to approach the waypoint and destination. When a vehicle arrives, a stop could be either on a left side or a right side.
    
*   `curbSide`: Ensures a minimal number of road crossings at waypoints or the destination. When a vehicle arrives, a stop should be on the right for the right-side driving road or on a left for the left-side driving road.
    

Default value: `anySide` Other value: `curbSide`

#### RoutePlanningLocations

Parameters

Description

`origin`

A GeoJSON object of type `Point`

Origin location for the route calculation.

*   The specified `GeoJSON` object **must** contain only the following 2 fields: `type` and `coordinates`.
    
*   The `type` field **must** have the value `Point`.
    
*   The `coordinates` field **must** be a single GeoJSON position, represented as an array of exactly 2 numbers: `[longitude, latitude]`.
    

For more information, see the [GeoJSON format](#geojson-format) section.

`waypoints`

A GeoJSON object of type `MultiPoint`

Optional, intermediate waypoint locations for the route calculation.

*   The specified `GeoJSON` object **must** contain only the following 2 fields: `type` and `coordinates`.
    
*   The `type` field **must** have the value `MultiPoint`.
    
*   The `coordinates` field **must** be an array of GeoJSON positions. Each element of the array represents a waypoint and is represented as an array of exactly 2 numbers: `[longitude, latitude]`. The array must contain at least one element if waypoints are specified.
    
*   The waypoints are used in the order they appear in the array.
    
*   The maximum allowed number of waypoints is 150.
    
*   A waypoint of type `location` results in an extra leg in the response.
    

For more information, see the [GeoJSON format](#geojson-format) section.

`destination`

A GeoJSON object of type `Point`

Destination location for the route calculation.

*   The specified `GeoJSON` object **must** contain only the following 2 fields: `type` and `coordinates`.
    
*   The `type` field **must** have the value `Point`.
    
*   The `coordinates` field **must** be a single GeoJSON position, represented as an array of exactly 2 numbers: `[longitude, latitude]`.
    

For more information, see the [GeoJSON format](#geojson-format) section.

#### RouteStop

Optional parameters

Description

`pauseDurationInSeconds`  
*integer*

Specifies the waiting duration at route stops. It must be 0 in the last leg (the destination).  
Default value: `0`

`entryPoints`  
*GeoJSON MultiPoint object*

Specifies the entry points for the stop at the end of the current leg in GeoJSON MultiPoint format. The route to the stop is calculated based on these entry points.

*   Entries with the same location are not allowed.
    
*   If specified, the coordinates array must not be empty.
    

For more details about GeoJSON, refer to the [RFC 7946](https://tools.ietf.org/html/rfc7946).

`preferredEntryPointIndex`  
*integer*

Specifies the index of the preferred entry point. An index of 0 denotes the first entry point. Selecting an entry point as preferred does not guarantee that it will be used as the destination.

*   Can only be specified if `entryPoints` are set.
    
*   Must be less than the number of coordinates in `entryPoints`.
    

#### Route avoid

The route calculation will try to avoid the specified road attribute for the leg that contains it.

Parameters

Description

`name`  
*string*

Specifies the name of the road attribute to configure.  
Possible values are listed under [Avoids parameter possible values](#avoids-parameter-possible-values).

#### entryPoints (GeoJSON MultiPoint)

The `entryPoints` field uses the GeoJSON MultiPoint format. Each coordinate is specified as `[longitude, latitude]`.

Example:

```
{  "type": "MultiPoint",  "coordinates": [    [13.50929, 52.36443],    [13.51781, 52.38909]  ]}
```

### Request content example

Note: for the purpose of brevity the following example may contain fields that are incompatible with others, and in practice only a subset of them will be present in the request.

post

Request content example

```
{  "avoidAreas": {    "rectangles": [      {        "type": "Feature",        "bbox": [2.26593, 48.81851, 2.41115, 48.90309],        "geometry": null      }    ]  },  "avoids": ["motorways", "ferries"],  "path": {    "type": "LineString",    "coordinates": [      [        13.42936,        52.50930      ],      [        13.42859,        52.50844      ],      [        13.42742,        52.50601      ]    ]  },  "legs": [    {      "routeType": "efficient",      "routeStop": {        "pauseDurationInSeconds": 610,        "entryPoints": {          "type": "MultiPoint",          "coordinates": [            [              13.42742,              52.50601            ]          ]        }      },      "avoids": [        {          "name": "tollRoads"        }      ]    },    {      "path": {        "type": "LineString",        "coordinates": [          [            13.42936,            52.5093          ],          [            13.42859,            52.50844          ],          [            13.42859,            52.50844          ]        ]      }    },    {      "routeType": "short"    }  ],  "vehicleHeadingInDegrees": 150,  "vehicleHasElectronicTollCollectionTransponder": "all",  "vehicleMaxSpeedInKilometersPerHour": 120,  "vehicleWeightInKilograms": 2000,  "traffic": "live"}
```

## Response field selection

The response field selection mechanism allows you to control which fields are included in or excluded from the API response. This is done through the required `Attributes` HTTP request header and the optional `Attributes-Exclude` header.

The `Attributes` header is required and specifies which response fields to include using a dot-notation format.

**Rules:**

1.  Any field listed in the `Attributes` header, including its sub-tree, will be included in the response if applicable.
2.  Fields marked as **EXPLICIT** (indicated by EXPLICIT in the response field documentation below) must be explicitly listed in this header to be returned. They are never included implicitly by specifying a parent field or by using a wildcard (`*`).
3.  The wildcard `*` can be used at deeper levels to include all non-EXPLICIT children of a field, but cannot be used as the only top-level value.

**Syntax:**

The value uses a listed dot-notation format:

```
Attributes: routes.summary, routes.legsAttributes: routes(summary, legs)Attributes: routes(*, someExplicitField)
```

The `(...)` notation can be used to group fields under a common parent and avoid repetition. The `(*, ...)` notation includes all non-EXPLICIT children plus the listed EXPLICIT fields.

**Examples:**

```
Attributes: routes                                -- includes all non-EXPLICIT fields under routesAttributes: routes, routes.someExplicitField      -- includes routes and an EXPLICIT fieldAttributes: routes(*, someExplicitField)          -- same as above using grouping notationAttributes: routes(summary, legs.summary)         -- includes only the specified fields
```

The `Attributes-Exclude` header specifies which response fields to exclude using the same dot-notation format.

**Rules:**

1.  Any field listed in the `Attributes-Exclude` header, including its entire sub-tree, will be omitted from the response.
2.  The exclusion is applied after the inclusion list and overrides it.
3.  The wildcard `*` is not allowed in the exclusion list.

**Example:**

```
Attributes:         routesAttributes-Exclude: routes.legs.path              -- include everything except the path geometry
```

### EXPLICIT response fields

Some response fields are marked as EXPLICIT and must be explicitly requested in the `Attributes` header. They are not included by default, even when their parent field is requested. This mechanism avoids unexpected increases in response size and computation cost.

This endpoint does not have any EXPLICIT response fields in this documentation.

## Response data

The following table describes the possible HTTP response headers.

Header

Description

[Access-Control-Expose-Headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Expose-Headers)

The service whitelists response headers that browsers are allowed to access.  
Value: `Content-Length`

[Access-Control-Allow-Origin](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Origin)

The service allows cross-origin resource sharing.  
Value: `*` (wildcard)

[Content-Encoding](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Encoding)

The service supports HTTP compression if requested by the client.  
Value: `gzip`

[Content-Language](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Language)

The language used when assembling the response, for example, selecting localized place names, phonetic translations, or other language‑dependent fields.  
Note that the returned content may still include text in other languages, depending on data availability and other factors.

[Content-Type](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Type)

The format of the response.  
Value: `application/json; charset=utf-8`

[Cache-Control](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control)

The Cache-Control general-header field is used to specify directives that must be obeyed by all caching mechanisms along the request/response chain. It is supported by HTTP/1.1 clients. It may not be supported by HTTP/1.0 clients.  
Values:

*   `no-cache`
*   `no-transform`

Tracking-ID

This is an identifier for the request. If `Tracking-ID` was specified in the request headers, it contains the same value. Otherwise it may contain a generated value.

### Response codes

The following table describes the possible HTTP response codes.

Code

Meaning & possible causes

`200`

OK: A route or range was calculated and the body of the response contains the data for a successful response.

`400`

Bad request: One or more parameters were:

*   Incorrectly specified.
    
*   Are mutually exclusive.
    
*   The points in the route request are not connected by the road network.
    
*   The points in the request are not near enough to a road.
    

`403`

Permission or authentication issues:

*   Forbidden
    
*   Not authorized
    
*   Account inactive
    

`404`

Not Found: The requested resource could not be found, but it may be available again in the future.

`405`

Method Not Allowed: The client used an HTTP method other than POST.

`408`

Request timeout: The client took too long to transmit the request.

`414`

Requested uri is too long.

`415`

Unsupported Media Type.

`429`

Too Many Requests: Too many requests were sent in a given amount of time for the supplied API Key.

`500`

An error occurred while processing the request. Please try again later. This can also indicate that the request reached an internal computation time threshold and timed out.

`502`

Internal network connectivity issue.

`503`

Service currently unavailable.

`504`

Internal network connectivity issue.

`596`

Service not found.

### Example of a successful response

The routes in a successful response are listed in the order of decreasing optimality. In case the request includes the `path` field, the response will specify the reconstructed route before any alternative routes.

Note: for the purpose of brevity the following example contains all the fields described in this document. In practice some fields are incompatible with others, and only a subset of them will be present in the response depending on the given request parameters.

A response could look like this: (Note: Comments are contained within `... ...`.)

Response body - JSON

```
{  "routes": [    {      "summary": {        "lengthInMeters": 1147,        "travelDurationInSeconds": 161,        "trafficDelayDurationInSeconds": 15,        "trafficLengthInMeters": 147,        "departureDateTime": "2015-04-02T15:01:57+02:00",        "arrivalDateTime": "2015-04-02T15:04:38+02:00"      },      "legs": [        {          "summary": {            "lengthInMeters": 108,            "travelDurationInSeconds": 11,            "trafficDelayDurationInSeconds": 0,            "trafficLengthInMeters": 0,            "departureDateTime": "2015-04-02T15:01:57+02:00",            "arrivalDateTime": "2015-04-02T15:02:07+02:00",            "originalWaypointIndexAtEndOfLeg": 0,            "entryPointIndexAtEndOfLeg": 0          },          "path": {            "type": "LineString",            "coordinates": [              [13.4293737, 52.5093087],              [13.4291258, 52.5090373],  ...further coordinates...            ]          },        },  ...further legs...      ],      "progressPoints": [        {          "pathIndex": 0,          "travelDurationInSeconds": 0,          "distanceInMeters": 0        },        {          "pathIndex": 5,          "travelDurationInSeconds": 7,          "distanceInMeters": 74        },  ...further progress points...        {          "pathIndex": 87,          "travelDurationInSeconds": 161,          "distanceInMeters": 1147        }      ],      "sections": {        "travelMode": [          {            "startPathIndex": 0,            "endPathIndex": 3,            "travelMode": "other"          },          {            "startPathIndex": 3,            "endPathIndex": 7,            "travelMode": "car"          }        ],        "toll": [          {            "startPathIndex": 2,            "endPathIndex": 5          }        ],        "tunnel": [          {            "startPathIndex": 3,            "endPathIndex": 4          }        ],        "pedestrian": [          {            "startPathIndex": 0,            "endPathIndex": 1          }        ],        "traffic": [          {            "startPathIndex": 3,            "endPathIndex": 4,            "iconCategory": "jam",            "effectiveSpeedInKilometersPerHour": 40,            "delayDurationInSeconds": 158,            "delayMagnitude": "minor",            "tec": {              "effectCode": 4,              "causes": [                {                  "mainCauseCode": 1                },                {                  "mainCauseCode": 26,                  "subCauseCode": 2                }              ]            }          }        ]  ...further sections...      }    }  ...further routes...  ]}
```

### Example of an error response

If an error occurs, the response contains the description of the error. The error response would look like this:

Error response example - JSON

```
{  "detailedError": {    "code": <error code>,    "message": "Error message"  }}
```

### Structure of a successful response

Note that some names are implicitly defined. One example is the name `leg` when describing `legs` as an array of `leg` objects.

JSON field

Description

`routes`  
*array of route objects*

The request may return more than one route.  
Each object has at least a `summary` field and a `legs` field. It may contain other fields depending on the request parameters.

`summary`  
*summary object*

The summary of a route, or of a route leg.  
The `summary` object may be extended with new fields in the future; clients should ignore fields they do not recognize.

`legs`  
*array of `leg` objects*

A description of a part of a route, comprised of an array of points.

*   Contains the `summary` field and may contain the `path` field.
    
*   Each additional waypoint provided in the request will result in an additional leg in the returned route.
    

`path` *object*

The route geometry in GeoJSON format. Contains a `type` field set to `LineString` and a `coordinates` array where each element is a position on the surface of the globe defined as `[longitude, latitude]`. For more information, see the [GeoJSON format](#geojson-format) section.

Example:

```
"path": {  "type": "LineString",  "coordinates": [    [-73.9857, 40.7484],    [-73.9851, 40.7496],    [-73.9845, 40.7508]  ]}
```

`sections`  
*object*

This object is available inside `route` objects.

*   It is a map where each key is a section type and each value is an array of section objects of that type.
    
*   The structure of `section` objects is given below.
    

`startPathIndex`  
*number*

Index of the first coordinate (offset `0`) in the route path this section applies to.

`endPathIndex`  
*number*

Index of the last coordinate (offset `0`) in the route path this section applies to.

`countryCodeIso2` *string*

A 2-character [ISO 3166-1 alpha-2](https://gist.github.com/tadast/8827699) country code.

`iconCategory`  
*string*

Type of the incident.

*   Can currently be `accident`, `brokenDownVehicle`, `dangerousConditions`, `flooding`, `fog`, `ice`, `jam`, `laneClosed`, `rain`, `roadClosed`, `roadWorks`, `wind`, or `unknown`.
    
*   See the `tec` field for detailed information.
    

`effectiveSpeedInKilometersPerHour` *number*

The effective speed of the incident in km/h, averaged over its entire length.

`delayDurationInSeconds`  
*number*

The delay duration in seconds caused by the incident.

`delayMagnitude`  
*string*

The magnitude of delay caused by the incident.  
Possible values:

*   `unknown`
*   `minor`
*   `moderate`
*   `major`
*   `undefined`, used for road closures and other indefinite delays
    

These values correspond to the values of the response field [`magnitudeOfDelay`](https://docs.tomtom.com/traffic-api/documentation/traffic-incidents/incident-details#structure-of-the--incidentproperties--object)

`tec`  
*object*

Details of the traffic event. It uses the definitions in the [TPEG2-TEC](https://www.iso.org/standard/63116.html) standard. It can contain the `effectCode` and `causes` fields.  
A selection of TPEG2-TEC causes can be found in the [Terms and definitions of Safety related message sets](https://tisa.org/wp-content/uploads/ITSTF20001_SafetyrelatedMessage-Sets-DATEXII_DENM_TPEG-TEC_TMC_-v1.5_FINAL-1.pdf).

`effectCode`  
*number*

The effect on the traffic flow. Contains a value in the `tec001:EffectCode` table, as defined in the [TPEG2-TEC](https://www.iso.org/standard/63116.html) standard. Can be used to color-code traffic events according to severity.

`causes`  
*array of objects*

Each object in the array describes one cause of the traffic event.

*   It can contain the `mainCauseCode` and `subCauseCode` fields.
    
*   It can be used to define iconography and descriptions.

`mainCauseCode`  
*number*

The main cause of the traffic event. Contains a value in the `tec002:CauseCode` table, as defined in the [TPEG2-TEC](https://www.iso.org/standard/63116.html) standard.  
A selection of TPEG2-TEC causes can be found in the [Terms and definitions of Safety related message sets](https://tisa.org/wp-content/uploads/ITSTF20001_SafetyrelatedMessage-Sets-DATEXII_DENM_TPEG-TEC_TMC_-v1.5_FINAL-1.pdf).

`subCauseCode`  
*number*

The sub-cause of the traffic event. Contains a value in the sub cause table defined by the `mainCauseCode`, as defined in the [TPEG2-TEC](https://www.iso.org/standard/63116.html) standard.  
A selection of TPEG2-TEC causes can be found in the [Terms and definitions of Safety related message sets](https://tisa.org/wp-content/uploads/ITSTF20001_SafetyrelatedMessage-Sets-DATEXII_DENM_TPEG-TEC_TMC_-v1.5_FINAL-1.pdf).

`eventId` *string*

A unique ID of the traffic incident.

`lengthInMeters`  
*number*

The route or leg length in meters.

`travelDurationInSeconds`  
*number*

The estimated travel duration in seconds depending on [`traffic`](#traffic).

*   If `traffic` has the value `historical`, then `travelDurationInSeconds` includes historical travel durations on the route.
    
*   If `traffic` has the value `live`, then `travelDurationInSeconds` includes historical travel durations as well as traffic jams during the travel time window on the route.
    

`trafficDelayDurationInSeconds`  
*number*

The delay duration in seconds compared to free-flow conditions according to real-time traffic information. Note that this is zero if `traffic` has the value `historical`.

`trafficLengthInMeters`  
*number*

The portion of the route or leg, expressed in meters, that is affected by traffic events which cause the delay.

`deviationDistanceInMeters` *number*

The distance (in meters) from the origin point of the request to the first point where this route forks off from the reference route.

*   If the route is identical to the reference route, then this field is set to the length of the route.
    
*   Included in all alternative (but not reference) `route` `summary` fields.
    

`deviationDurationInSeconds` *number*

The travel duration (in seconds) from the origin point of the request to the first point where this route forks off from the reference route.

*   If the route is identical to the reference route, then this field is set to the estimated travel duration of the route.
    
*   Included in all alternative (but not reference) `route` `summary` fields.
    

`deviationPoint`  
*object*

The coordinates of the first point following the origin point of the request where this route forks off from the reference route. The value is in GeoJSON format.

*   If the route is identical to the reference route, then this field is set to the coordinates of the last point on the route.
    
*   Included in all alternative (but not reference) `route` `summary` fields.
    

Example:

```
"deviationPoint": {  "type": "Point",  "coordinates": [    -73.9857,    40.7484  ]}
```

For more details, see the [GeoJSON format for deviation points](#geojson-format-for-deviation-points) section.

`departureDateTime`  
*string*

The estimated departure date and time for the route or leg. Specified as a `dateTime`.

`arrivalDateTime`  
*string*

The estimated arrival date and time for the route or leg. Specified as a `dateTime`.

`progressPoints`  
*array of progress point objects*

*   It always contains entries for the first and the last point in the route.
    
*   For any pair of consecutive entries in the `progressPoints` array, progress for `pathIndex` values that are not explicitly present and are enclosed by said pair, can be linearly interpolated by summing up straight line distances of the leg points.
    
*   The [Haversine formula](https://en.wikipedia.org/wiki/Haversine_formula) is precise enough to compute such distances.
    

A `progress point` object may contain the following members:

*   `pathIndex`: index of the point (offset `0`) in the route this object applies to.
    
*   `distanceInMeters`: distance (in meters) from the start of the route to this point.
    
*   `travelDurationInSeconds`: travel duration (in seconds) from the start of the route to this point.
    

`originalWaypointIndexAtEndOfLeg`  
*number*

The index of the waypoint at the end of the leg.  
This index corresponds to the position of this waypoint in the list of waypoints in the `routePlanningLocations` POST data parameter in the request.  
The first waypoint has an index equal to 0.  
This field is not provided if the end of the leg corresponds to the destination.

`entryPointIndexAtEndOfLeg`  
*number*

Identifies the entry point that was used for the route at the end of the leg.  
This index corresponds to the position of this entry point in the list of entry points within the respective leg.  
The first entry point has an index equal to 0.  
This field is only present if the leg had `entryPoints` in the request.

### Structure of the `section` object

Each `section` object contains additional information about parts of a route. A `section` object contains at least the fields `startPathIndex` and `endPathIndex`. The section type is indicated by the key under which the array of section objects appears in the `sections` map.

JSON field

Description

*sections map key*  
*string*

The key in the `sections` map identifies the section type. The possible keys are: `carTrain`, `country`, `ferry`, `motorway`, `pedestrian`, `toll`, `traffic`, `travelMode`, `tunnel`, `carpool`, `urban`, `unpaved`, `lowEmissionZone`, `speedLimit`.

*   The `country` sections span between country border crossings, from the departure, or to the destination.
    
    *   The section additionally contains `countryCodeIso2` — the country code of the country in the `ISO 3166-1 alpha-2` format.
        
    *   If the route has disjointed parts in the same country, there will be several sections with the same `countryCodeIso2`.
        
    *   If no country can be assigned to a part of the route, as for example in international waters, there may be no country section for this part.
        
*   A `traffic` section may additionally contain any of the following: `iconCategory`, `effectiveSpeedInKilometersPerHour`, `delayDurationInSeconds`, `delayMagnitude`, `tec`, `eventId`.
    
*   `travelMode` sections cover the whole route. Each section’s travel mode is reported in `travelMode` .
    
*   A `speedLimit` section additionally contains `speedRestrictions` list of objects.  
    Each object in the `speedRestrictions` list contains `type` field (a string with value `maximum`) and `inKilometersPerHour` integer.
    

`travelMode`  
*string*

This field is either set to the value given to the POST data parameter `travelMode`, if this travel mode is possible, or to `other` which indicates that the given mode of transport is not possible in this section. This field can only be used within sections of type `travelMode`.

### Structure of an error response

JSON field

Description

`detailedError`

*object*

This object provides a representation of the error message. It contains a `code` and a `message` field.

JSON field

Description

`code`

*string*

The (non-complete) list of error codes is:

Error code

Description

`MAP_MATCHING_FAILURE`

One of the input points (Origin, Destination, Waypoints) could not be matched to the map because there is no known drivable section near this point. This error code is always followed by a description of one point that was not matchable:

*   Origin (Latitude, Longitude)
    
*   Destination (Latitude, Longitude)
    
*   Waypoint N (Latitude, Longitude)
    

`NO_ROUTE_FOUND`

No valid route could be found.

`CANNOT_RESTORE_BASEROUTE`

The route reconstruction using `path` failed.

`BAD_INPUT`

Some input parameter combination was not valid.

`COMPUTE_TIME_LIMIT_EXCEEDED`

The request exceeded the internal compute time limit and was canceled.

`message` *string*

A human readable error message.

*   It is a freeform string which may be extended in the future, so it is recommended to only match substrings of the description.
    
*   The string always contains an error code.
    

#### Example of a description string:

`   Engine error while executing route request: MAP_MATCHING_FAILURE: Origin (54.3226, 3.11463)   ``   Engine error while executing route request: MAP_MATCHING_FAILURE: Destination (54.3226, 3.11463)   ``   Engine error while executing route request: MAP_MATCHING_FAILURE: Waypoint 3 (54.3226, 3.11463)   `

## GeoJSON format

GeoJSON is a format for encoding geographic data using JSON, representing features and attributes.

### Structure of GeoJSON object

A GeoJSON object includes:

`Type`: Specifies the object type, e.g. `LineString`, `Point`, etc. `Coordinates`: Geographic coordinates in arrays, varying by geometry type, for example:

*   Point: \[longitude, latitude\].
*   LineString: Array of coordinate pairs, in format `[longitude, latitude]`.

For more details, refer to the [RFC 7946](https://tools.ietf.org/html/rfc7946)

## GeoJSON format for deviation points

Fields such as `deviationPoint` in the response are represented as GeoJSON objects. For these cases, the object will have:

*   `"type": "Point"`
*   `"coordinates"`: an array containing a single `[longitude, latitude]` pair.

Example:

```
{  "type": "Point",  "coordinates": [13.42936, 52.50930]}
```

For more details, refer to the [RFC 7946](https://tools.ietf.org/html/rfc7946)