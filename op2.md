# Asynchronous Matrix Submission | Matrix Routing v2 API

## Purpose

This endpoint enables the submission of a new matrix job for asynchronous processing. It responds with a unique job id which can be used to check the job status and download its result when available.

## API Limitations

*   Matrices don’t need to be square.

Max matrix  
size

Max number  
of origins

Max number  
of destinations

Additional limits

`2500`

`1000`

`1000`

Unlimited bounding box if all the following conditions are met:

*   [`departAt`](#post-body-field-departat) or [`arriveAt`](#post-body-field-arriveat) is set to `any`.
    
*   [`traffic`](#post-body-field-traffic) is set to `historical`.
    
*   [`routeType`](#post-body-field-routetype) is set to `fastest`.
    
*   [`travelMode`](#post-body-field-travelmode) is set to either `car` or `truck`.
    
*   No other parameters are explicitly used.

Otherwise:

*   Origins and destinations must fit within a 400 km x 400 km bounding box.
*   If not, some matrix cells will will be resolved as [`OUT_OF_REGION`](#outOfRegionCode).

`100M`

`10000`

`10000`

*   Only available for Enterprise pricing plan customers.
*   [`departAt`](#post-body-field-departat) or [`arriveAt`](#post-body-field-arriveat) must be `any`.
*   [`traffic`](#post-body-field-traffic) must be `historical`.
*   [`routeType`](#post-body-field-routetype) must be `fastest`.
*   [`travelMode`](#post-body-field-travelmode) must be either `car` or `truck`.
*   No other parameters can be used explicitly.

Check our [Pricing](https://docs.tomtom.com/pricing) and [Contact Sales](https://www.omtom.com/contact-sales/) for quotas tailored based on your needs.

## Types

The following data table describes the complex data types that can be used in the Matrix Routing v2 service.

Type

Description

`point`  
*object*

Latitude, longitude pair (in [EPSG:4326](https://spatialreference.org/ref/epsg/4326/) projection), with the following constraints:

*   Latitude values must be in the range `[-90, +90]`.
*   Longitude values must be in the range `[-180, +180]`.

**Example:**  
`{"latitude": 52.37245, "longitude": 4.89406}`

`dateTime`  
*string*

A date and time specified in [RFC 3339](https://tools.ietf.org/html/rfc3339) format with an optional time zone offset.  
**Example:**

*   `2022-12-19T16:39:57`
*   `2022-12-19T16:39:57-08:00`

## Request data

### HTTPS method: `POST`

*   Constants and parameters enclosed in curly brackets { } **must be replaced** with their values.
*   Please see the following [Request parameters](#request-parameters) section with the required and optional parameters tables for their values. The generic request format is as follows.

#### URL request format

All of the following parameters are required:

```
https://{baseURL}/routing/matrix/{versionNumber}/async?key={Your_API_Key}
```

#### Example

```
https://api.tomtom.com/routing/matrix/2/async?key={Your_API_Key}
```

#### curl command request format

post

curl command request format

```
curl -XPOST 'https://{baseURL}/routing/matrix/{versionNumber}/async?key={Your_API_Key}'
```

The following table describes HTTP request headers of particular interest to Matrix Routing v2 service clients.

Required header

Description

[Content-Type](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Type)

Specifies the MIME type of the body of the request.  
**Value:** `application/json`

Optional headers

Description

Tracking-ID

Specifies an identifier for the request. It can be used to trace a call.

*   The value must match the regular expression `'^[a-zA-Z0-9-]{1,100}$'`.
*   An example of the format that matches this regular expression is UUID: (e.g., `9ac68072-c7a4-11e8-a8d5-f2801f1b9fd1`).
*   For details check [RFC 4122](https://tools.ietf.org/html/rfc4122).
*   If specified, it is replicated in the [Tracking-ID](#trackingid-response) response header.
*   It is only meant to be used for support and does not involve tracking of you or your users in any form.

**Value:** An `identifier` for the request.

### Request parameters

The following table describes the request parameters.

*   Required parameters **must be used** or the call will fail.
*   A parameter’s data type is beneath its name.

Required parameters

Description

`baseURL`  
*string*

Base URL for calling the API.  
**Values:**

*   `api.tomtom.com`: The default global API endpoint.
*   `kr-api.tomtom.com`: The region-specific endpoint for South Korea. See the [region-specific content documentation](https://docs.tomtom.com/platform/documentation/region-specific-content)

`versionNumber`  
*string*

Service version.  
**Value:** The current value is `2`.

`key`  
*string*

An API Key valid for the requested service.  
**Value:** Your valid `API Key`.

### POST request body - JSON

The POST body of a matrix request should contain a set of items which will be used to calculate a matrix of route summaries.

post

POST request body - JSON

```
{  "origins": [    {      "point": {"latitude": latitudeValue,"longitude": longitudeValue}    },    ...,    {      "point": {"latitude": latitudeValue,"longitude": longitudeValue}    }  ],  "destinations": [    {      "point": {"latitude": latitudeValue,"longitude": longitudeValue}    },    ...,    {      "point": {"latitude": latitudeValue,"longitude": longitudeValue}    }  ],  "options": {    "departAt": dateTime | "any" | "now",    "arriveAt": dateTime | "any",    "routeType": "fastest" | "shortest",    "traffic": "historical" | "live",    "travelMode": "car" | "truck" | "pedestrian",    "vehicleMaxSpeed": integer,    "vehicleWeight": integer,    "vehicleAxleWeight": integer,    "vehicleLength": float,    "vehicleWidth": float,    "vehicleHeight": float,    "vehicleCommercial": boolean,    "vehicleLoadType": [ string, ... ],    "vehicleAdrTunnelRestrictionCode": string,    "avoid": [ string, ... ]  }}
```

### POST request body fields

This section contains the detailed description of allowed fields in the POST body.

Required fields

Description

`origins`  
*array*

A non-empty list of origin locations represented by [points](#types-point).  
**Value:** An array of locations (latitude, longitude pairs).

`destinations`  
*array*

A non-empty list of destination locations represented by [points](#types-point).  
**Value:** An array of locations (latitude, longitude pairs).

Mutually exclusive fields

Description

`departAt`  
*string*

The date and time of departure from the origin point.

*   Departure times apart from `any` and `now` must be specified as a [`dateTime`](#types-dateTime) in the future.
*   When a time zone offset is not specified, it will be assumed to be that of the origin point for each individual cell.
*   Specifying a value for the `departAt` parameter or using the default value is recommended for matrices having multiple destinations.
*   The `departAt` parameter **cannot be used** in conjunction with `arriveAt`.

**Default value:** `any` if `arriveAt` is not specified.  
**Values:**

*   `any` - This mode is tailored to the use case where the time context is irrelevant. The `traffic=live` parameter value **cannot be used** together with `any`.
*   `now` - The departure time will be set to the processing time of each individual cell. Processing time may be any time between the matrix job submission and its completion. This mode is best used together with `traffic=live`, as the service will then always consider the most recent available traffic information during routing.
*   [`dateTime`](#types-dateTime)

`arriveAt`  
*string*

The date and time of arrival at the destination point.

*   Departure times apart from `any` must be specified as a [`dateTime`](#types-dateTime) in the future.
*   When a time zone offset is not specified, it will be assumed to be that of the destination point for each individual cell.
*   Specifying a value for `arriveAt` parameter is recommended for matrices having multiple origins.
*   The `arriveAt` parameter **cannot be used** in conjunction with `departAt`.

**Values:**

*   `any` - See `departAt=any` for details.
*   [`dateTime`](#types-dateTime)

`traffic`  
*string*

Decides how traffic is considered for computing routes.  
**Default value:** `historical`  
**Values:**

*   `historical` - Routing and estimated travel time consider historical travel times and long term closures. Traffic jams and short-term closures during the travel time window do not influence routing or travel time.
*   `live` - In addition to historical travel times, routing and estimated travel time consider traffic jams and short- and long-term closures during the travel time window.  
    **Note:** `traffic=live` may not be used in conjunction with travel time `any`, also see`arriveAt` and `departAt`.

Optional fields

Description

`routeType`  
*string*

The type of route requested.  
**Default value:** `fastest`  
**Values:**

*   `fastest`: Route calculation is optimized by travel time, while keeping the routes sensible. For example, the calculation may avoid shortcuts along inconvenient side roads or long detours that only save very little time.
*   `shortest`: Route calculation is optimized by travel distance, while keeping the routes sensible. For example, straight routes are preferred over those incurring turns.

`travelMode`  
*string*

The mode of travel for the requested route.  
**Default value:** `car`  
**Other values:** `truck`, `pedestrian`

`vehicleMaxSpeed`  
*integer*

Maximum speed of the vehicle in kilometers/hour.

*   Must have a value in the range `[0, 250]`.
*   A value of `0` means that an appropriate value for the vehicle will be determined and applied during route planning.

**Default value:** `0`

`vehicleWeight`  
*integer*

Weight of the vehicle in kilograms. A value of `0` means that weight restrictions are not considered.  
**Default value:** `0`

`vehicleAxleWeight`  
*integer*

Weight per axle of the vehicle in kilograms. A value of `0` means that weight restrictions per axle are not considered.  
**Default value:** `0`

`vehicleLength`  
*float*

Length of the vehicle in meters. A value of `0` means that length restrictions are not considered.  
**Default value:** `0`

`vehicleWidth`  
*float*

Width of the vehicle in meters. A value of `0` means that width restrictions are not considered.  
**Default value:** `0`

`vehicleHeight`  
*float*

Height of the vehicle in meters. A value of `0` means that height restrictions are not considered.  
**Default value:** `0`

`vehicleCommercial`  
*boolean*

Vehicle is used for commercial purposes and thus may not be allowed to drive on some roads.  
**Default value:** `false`  
**Other values:** `true`

`vehicleLoadType`  
*array*

Specifies types of cargo that may be classified as hazardous materials and are restricted from some roads.  
Available values are:

*   US Hazmat classes 1 through 9
*   Generic classifications for use in other countries.

Use these values for routing in the USA:

*   `USHazmatClass1`: Explosives
*   `USHazmatClass2`: Compressed gas
*   `USHazmatClass3`: Flammable liquids
*   `USHazmatClass4`: Flammable solids
*   `USHazmatClass5`: Oxidizers
*   `USHazmatClass6`: Poisons
*   `USHazmatClass7`: Radioactive
*   `USHazmatClass8`: Corrosives
*   `USHazmatClass9`: Miscellaneous

Use these values for routing in all other countries:

*   `otherHazmatExplosive`: Explosives
*   `otherHazmatGeneral`: Miscellaneous
*   `otherHazmatHarmfulToWater`: Harmful to water

**Notes:**

*   The `vehicleLoadType` and `vehicleAdrTunnelRestrictionCode` parameters are independent; please provide both if applicable.

`vehicleAdrTunnelRestrictionCode`  
*string*

If `vehicleAdrTunnelRestrictionCode` is specified, the vehicle is subject to ADR tunnel restrictions.

*   Vehicles with code `B` are restricted from roads with ADR tunnel categories B, C, D, and E.
*   Vehicles with code `C` are restricted from roads with ADR tunnel categories C, D, and E.
*   Vehicles with code `D` are restricted from roads with ADR tunnel categories D and E.
*   Vehicles with code `E` are restricted from roads with ADR tunnel category E.
*   If `vehicleAdrTunnelRestrictionCode` is not specified, no ADR tunnel restrictions apply.

**Note:** The `vehicleAdrTunnelRestrictionCode` and `vehicleLoadType` parameters are independent; please provide both if applicable.  
**Values** (specify at most one):

*   `B`
*   `C`
*   `D`
*   `E`

**Reference:** [European Agreement Concerning the International Carriage of Dangerous Goods by Road (ADR), United Nations, 2019, section 1.9.5 and chapter 8.6](https://unece.org/about-adr)

`avoid` *array*

Specifies something that the route calculation should try to avoid when determining the route.  
Available values are:

*   `tollRoads`: Avoids toll roads.
*   `unpavedRoads`: Avoids unpaved roads.

### POST request body example

post

POST request body example - JSON

```
{  "origins": [    {      "point": { "latitude": 45.458545, "longitude": 9.15049 }    },    {      "point": { "latitude": 45.403337, "longitude": 11.050541 }    }  ],  "destinations": [    {      "point": { "latitude": 48.149853, "longitude": 11.499931 }    },    {      "point": { "latitude": 50.033688, "longitude": 14.538226 }    }  ],  "options": {    "departAt": "2022-12-19T16:39:57",    "routeType": "fastest",    "traffic": "historical",    "travelMode": "truck",    "vehicleMaxSpeed": 90,    "vehicleWeight": 12000,    "vehicleAxleWeight": 4000,    "vehicleLength": 13.6,    "vehicleWidth": 2.42,    "vehicleHeight": 2.4,    "vehicleCommercial": true,    "vehicleLoadType": ["otherHazmatExplosive", "otherHazmatGeneral"],    "vehicleAdrTunnelRestrictionCode": "C",    "avoid": ["unpavedRoads"]  }}
```

## Response data

### Matrix Submission response

On a successful matrix request submission, the Matrix Routing v2 service responds with an HTTP `202`.

The response contains a matrix job ID which can be used to check the matrix job status using the [Asynchronous Matrix Status](https://docs.tomtom.com/matrix-routing-v2-api/documentation/asynchronous-matrix-status) endpoint and download the result of the matrix processing after its completion using the [Asynchronous Matrix Download](https://docs.tomtom.com/matrix-routing-v2-api/documentation/asynchronous-matrix-download) endpoint. The response also contains the current status of the matrix job.

### HTTP status codes

Code

Meaning and possible causes

`202`

**Accepted**: Request successful, information about the matrix job’s Id and current status will be returned to the client.

`400`

**Bad Request**: Request cannot be processed correctly, e.g., due to invalid header values.

`403`

**Forbidden**: The API Key is missing, inactive, invalid, not entitled to use Matrix Routing v2 API, or exceeded the available quota. This can also occur when using HTTP instead of HTTPS.

`404`

**Not Found**: The requested resource could not be found, but it may be available again in the future.

`405`

**Method Not Allowed**: The client used an HTTP method other than POST.

`414`

**Requested URI is too long**: Indicates that the URI requested by the client is longer than the server is willing to interpret.

`415`

**Unsupported Media Type**: The client used an unsupported media type.

`429`

**Too Many Requests**: Quota was exceeded for the API Key.

`500`

**An error occurred while processing the request**. Please try again later.

`502`

**Internal network connectivity issue**. Please try again later.

`503`

**Service currently unavailable**. Please try again later.

`504`

**Internal network connectivity issue or a request that has taken too long to complete**. Please try again later.

`596`

**Service not found**. Request contains an incorrect FQDN and/or path.

The following table lists HTTP response headers of particular interest to the Matrix Routing v2 service clients.

Header

Description

[Access-Control-Expose-Headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Access_control_CORS#Access-Control-Expose-Headers)

A comma separated list of HTTP header names that browsers are allowed to access.  
**Value:** `Content-Length`

[Access-Control-Allow-Origin](https://developer.mozilla.org/en/docs/HTTP/Access_control_CORS#Access-Control-Allow-Origin)

A header instructing browsers to allow customer websites to contact the Matrix Routing v2 service.  
**Value:** `*`

[Content-Encoding](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Encoding)

The Matrix Routing v2 service applies gzip compression to the response if it is requested by the client with the [Accept-Encoding](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Accept-Encoding) header.  
**Value:** `gzip`

[Content-Type](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Type)

The format of the response.  
**Value:** `application/json;charset=utf-8`

Tracking-ID

An identifier for the request.

*   If the [Tracking-ID](#trackingid-request) header was specified, it is replicated in the response.
*   Otherwise, it is generated automatically by the service.
*   It is only meant to be used for support and does not involve tracking of you or your users in any form.

*Value:*\* An `identifier` for the request.

### Successful response format

```
HTTP 200 OK{  "jobId": "unique matrix job id",  "state": "Submitted"}
```

### Successful response example

```
HTTP 200 OK{  "jobId": "00-00000000-0000-0000-0000-000000000000-0000",  "state": "Submitted"}
```

### Successful response fields

Primary fields

Description

`jobId`  
*string*

The matrix job ID which can be used to check the matrix job status using the [Asynchronous Matrix Status](https://docs.tomtom.com/matrix-routing-v2-api/documentation/asynchronous-matrix-status) endpoint and download the result of the matrix processing after its completion using the [Asynchronous Matrix Download](https://docs.tomtom.com/matrix-routing-v2-api/documentation/asynchronous-matrix-download) endpoint. The response also contains the current status of the matrix job.

`state`  
*string*

Current state of the matrix job.

### Error response example

Error response example - JSON

```
{  "detailedError": {    "code": "BAD_REQUEST",    "message": "Bad Request",    "details": [      {        "code": "BAD_ARGUMENT",        "message": "Tracking-ID must match ^[a-zA-Z0-9-]{1,100}$ pattern.",        "target": "trackingId",        "innerError": {          "code": "INVALID_PARAMETER_VALUE"        }      }    ]  }}
```

### Error response fields

Primary fields

Field

Description

`detailedError`  
*object*

Detailed information about the error.  
[`detailedError`](#detailederror-object) object

detailedError object

Field

Description

`code`  
*string*

One of the defined [error codes](#error-code-hierarchy).

`message`  
*string*

A human-readable description of the error code. It is intended as an aid to developers and is not suitable for exposure to end users.

`target`  
*string*

Optional. Target of the particular error. For example, a parameter name, a path to a JSON property, and others. Contents of this field may change over time.

`details`  
*array*

Optional. An array of root causes (more detailed errors) that led to this error.  
[`detailedError`](#detailederror-object) object

`innerError`  
*object*

Optional. A higher level of details about this error.  
[`innerError`](#innererror-object) object

innerError object

Field

Description

`code`  
*string*

One of the defined [error codes](#error-code-hierarchy).

`message`  
*string*

Optional. A human-readable representation of the error code. It is intended as an aid to developers and is not suitable for exposure to end users.

`innerError`  
*object*

Optional. A higher level of details about this error.  
[`innerError`](#innererror-object) object

### Error code hierarchy

List of predefined, hierarchical, human-readable error codes.

*   Top level codes relate to HTTP error codes.
*   They may be refined by error codes in `details` or `innerError`.
*   Further levels of refinement are possible by nesting `innerError` inside `innerError`.

In the future, the list may be extended with additional codes. New or existing codes may be introduced as children of codes already present in the hierarchy. The application must be ready for the occurrence of an unknown error code (e.g., by stopping error processing at the last understood level of detail).

Error code

Description

`NOT_FOUND`

Top level code for requests which failed with an HTTP `404` status code, caused by providing an incorrect request path.

`BAD_REQUEST`

Top level code for requests which failed with an HTTP `400` status code.  
Current possible details: `BAD_ARGUMENT`

`INTERNAL_SERVER_ERROR`

Top level code for requests which failed with an HTTP `500` status code. The service cannot handle the request right now, an unexpected condition was encountered.

`SERVICE_UNAVAILABLE`

Top level code for requests which failed with an HTTP `503` status code. The service cannot handle the request right now, this is certainly a temporary state.

`FORBIDDEN`

Top level code for requests which failed with an HTTP `403` status code.  
Current possible details: `OVER_TRANSACTION_LIMIT`

`BAD_ARGUMENT`

One of the request parameters did not pass validation. The optional **target** field may contain the name of the related parameter, or the location inside the JSON object in the request POST body.  
Current possible inner errors: `INVALID_PARAMETER_VALUE`

`MISSING_REQUIRED_PARAMETER`

One of the required parameters was not provided.

`INVALID_PARAMETER_VALUE`

The value of one of the parameters is invalid.

`OVER_TRANSACTION_LIMIT`

Client has exceeded the transaction limit.

`OUT_OF_REGION`

The distance between the given origin and destination pair is too long to calculate the route, considering other requested options.  
See the [API Limitations table](#apiLimitationsTable) for more information.