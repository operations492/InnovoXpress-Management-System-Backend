# Asynchronous Matrix Download | Matrix Routing v2 API

## Purpose

This endpoint lets clients download the result of their matrix job.

*   A `matrixJobId` is required for a result download. This Id is available inside the body of a successful [Asynchronous Matrix Submission](https://docs.tomtom.com/matrix-routing-v2-api/documentation/asynchronous-matrix-submission) response.
*   To download the result, the job must be in the `Completed` state.
*   The current state of a job may be checked using the [Asynchronous Matrix Status](https://docs.tomtom.com/matrix-routing-v2-api/documentation/asynchronous-matrix-status) endpoint.
*   For submissions containing 1,000,000 items or fewer, the results of a completed job will be provided in the HTTP 200 response body.
*   For submissions exceeding 1,000,000 items, please follow the HTTP 302 Location header to download the results. It is recommended to configure your HTTP client to automatically follow redirects.
*   A result download request for a non-`Completed` matrix job will end with an HTTP 404 response.

## Types

The following data table describes the complex data types that can be used in the Matrix Routing v2 service.

Types

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
**Examples:**

*   `2023-12-19T16:39:57`
    
*   `2023-12-19T16:39:57-08:00`
    

## Request data

### HTTPS method: `GET`

*   Constants and parameters enclosed in curly brackets { } **must be replaced** with their values.
*   Please see the following [Request parameters](#request-parameters) section with the required and optional parameters tables for their values. The generic request format is as follows.

#### URL request format

All of the following parameters are required:

```
https://{baseURL}/routing/matrix/{versionNumber}/async/{matrixJobId}/result?key={Your_API_Key}
```

#### URL request example

```
https://api.tomtom.com/routing/matrix/2/async/00-00000000-0000-0000-0000-000000000000-0000/result?key={Your_API_Key}
```

#### curl command request format

get

curl command request format

```
curl 'https://{baseURL}/routing/matrix/{versionNumber}/async/{matrixJobId}/result?key={Your_API_Key}'
```

The following table describes HTTP request headers of particular interest to Large-scale Matrix Routing service clients.

Required headers

Description

[Accept-Encoding](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Accept-Encoding)

Restricts the content codings that are acceptable in the response. This header is required so that the service can apply gzip compression.  
**Value:** `gzip`

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
*   Optional parameters may be used.
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

The version of the service to call.  
**Value:** `2`

`matrixJobId`  
*string*

Id of the matrix job to check. It is provided in the response body of a submission request.  
**Value:** `string`

`key`  
*string*

An API Key valid for the requested service.  
**Value:** Your valid `API Key`.

## Response data

### HTTP status codes

Code

Meaning & possible causes

`200`

**Request successful**: Matrix job’s result will be included in the response body.

`302`

**Request successful**: Matrix job’s result is available at the address given in the [Location](#location-header) header. Your HTTP client may perform an automatic redirect, depending on its configuration.

`403`

**Forbidden**: The API Key is missing, inactive, invalid, not entitled to use Matrix Routing v2 API, or exceeded the available quota. This can also occur when using HTTP instead of HTTPS.

`404`

**The requested resource could not be found**, possible reasons:

*   A job with the provided Id exists, but it’s not in `Completed` state.
    
*   A job with the provided Id doesn’t exist.
*   A job with the provided Id did exist but the retention period has passed, and the status is no longer available.
    
*   The provided job Id and the API Key do not match.
*   URI path not found.

`405`

**Method Not Allowed**: The client used an HTTP method other than `GET`.

`406`

**Not Acceptable**: The client should declare readiness for receiving the gzip compressed response by using the Accept-Encoding header.

`414`

**Requested URI is too long**: Indicates that the URI requested by the client is longer than the server is willing to interpret.

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

The following table lists HTTP response headers of particular interest to Matrix Routing v2 service clients.

Header

Description

[Location](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Location)

The Location header indicates the URL the client should follow to download the matrix job’s result.  
The header is present in the response if the response code is [HTTP 302](#response-code-302). The URL is temporary and may change; therefore HTTP client must not cache this address. Instead, the client should make a request to download the endpoint every time they need to download the result.  
**Value:** the URL of the the matrix job’s result.

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

The format of the response as chosen by the client (see the `contentType` request parameter).  
**Value:** `application/json;charset=utf-8`

Tracking-ID

An identifier for the request. If the [Tracking-ID](#trackingid-request)  
header was specified, it is replicated in the response. Otherwise, it is generated automatically by the service. It is only meant to be used for support and does not involve tracking of you or your users in any form.  
**Value:** An `identifier` for the request.

### Successful response

Response body format - JSON

```
HTTP 200 OK{  "data": [    {      "originIndex": integer,      "destinationIndex": integer,      "routeSummary": {        "lengthInMeters": integer,        "travelTimeInSeconds": integer,        "trafficDelayInSeconds": integer,        "departureTime": dateTime,        "arrivalTime": dateTime      },      "detailedError": object    },    ...  ],  "statistics": {    "totalCount": integer,    "successes": integer,    "failures": integer,    "failureDetails": [      {        "code": string,        "count": integer      },      ...    ]  }}
```

Response body example - JSON

```
HTTP 200 OK{  "data": [    {      "originIndex": 0,      "destinationIndex": 0,      "routeSummary": {        "lengthInMeters": 681999,        "travelTimeInSeconds": 25106,        "trafficDelayInSeconds": 1769,        "departureTime": "2018-08-10T10:20:42+02:00",        "arrivalTime": "2018-08-10T17:19:07+02:00"      }    },    {      "originIndex": 0,      "destinationIndex": 1,      "detailedError": {        "code": "CELL_PROCESSING_ERROR",        "message": "Cell could not be processed",        "innerError": {          "code": "MAP_MATCHING_FAILURE",          "message": "Engine error while executing route request: MAP_MATCHING_FAILURE: Destination (2.2, 2.2)"        }      }    },    {      "originIndex": 0,      "destinationIndex": 2,      "detailedError": {        "code": "CELL_PROCESSING_ERROR",        "message": "Cell could not be processed",        "innerError": {          "code": "UNKNOWN",          "message": "Unknown error occurred"        }      }    }  ],  "statistics": {    "totalCount": 3,    "successes": 1,    "failures": 2,    "failureDetails": [      {        "code": "MAP_MATCHING_FAILURE",        "count": 1      },      {        "code": "UNKNOWN",        "count": 1      }    ]  }}
```

### Successful response fields

Primary fields

Field

Description

`data`  
*array*

Contains all calculated route summaries for this matrix. Comparing to the matrix submission body structure, which is two-dimensional, the `data` structure is flattened to a single dimension. In order to be able to refer to a specific origin/destination pair, also the `originIndex` and the `destinationIndex` fields are also available.  
[`data`](#data-array) array

`statistics`  
*object*

Optional field, present when the state is `Completed`. Contains information about statistics for this matrix.  
[`statistics`](#statistics-object) object

data array

Field

Description

`originIndex`  
*integer*

Zero-based index of the origin of a route.

`destinationIndex`  
*integer*

Zero-based index of the destination of a route.

`routeSummary`  
*object*

Optional field containing the result of a successful route summary calculation.

`lengthInMeters`  
*integer*

Element of `routeSummary`. The route length in meters.

`trafficDelayInSeconds`  
*integer*

Element of `routeSummary`. The delay in seconds compared to free-flow conditions according to real-time traffic information.

`departureTime`  
*dateTime*

Element of `routeSummary`. If `departAt` or `arriveAt` is  
`any`, then `departureTime` is absent. In all other cases  
`departureTime` contains the estimated departure time for the route. Specified as a [`dateTime`](#types-dateTime).

`arrivalTime`  
*dateTime*

Element of `routeSummary`. If `departAt` or `arriveAt` is  
`any`, then `arrivalTime` is absent. In all other cases  
`arrivalTime` contains the estimated arrival time for the route. Specified as a [`dateTime`](#types-dateTime).

`travelTimeInSeconds`  
*integer*

Element of `routeSummary`. The estimated travel time in seconds depending on [`traffic`](https://docs.tomtom.com/matrix-routing-v2-api/documentation/asynchronous-matrix-submission#post-body-field-traffic).

*   If `traffic=historical`, then `travelTimeInSeconds` includes historical travel times on the route.
    
*   If `traffic=live`, then `travelTimeInSeconds` includes historical travel times as well as traffic jams during the travel time window on the route.
    

`detailedError`  
*object*

Optional field, present in an HTTP 200 response body only when there was a problem processing a matrix cell. This field describes the details of a failure, per matrix cell. It is possible that the whole matrix job may be completed and the result is downloaded having an HTTP 200 status while at the same time multiple, or even all the cells have failed. The content of this object is defined the same as in the case of an error response:  
[`detailedError`](#fieldDetailedError) object

statistics object

Field

Description

`totalCount`  
*integer*

Total number of routes within this matrix.

`successes`  
*integer*

Number of successful routes within this matrix.

`failures`  
*integer*

Number of failed routes within this matrix.

`failureDetails`  
*array*

When there are any failed cells, this field contains the details about the failure(s).  
[`failureDetails`](#failuredetails-array) array

failureDetails array

Field

Description

`code`  
*string*

One of the defined [error codes](#error-code-hierarchy).

`count`  
*integer*

Number of failed route calculations within this matrix caused by errors having given `code`.

### Error response

Error response format - JSON

```
{  "detailedError": {    "code": string,    "message": string,    "details": [      {        "code": string,        "message": string,        "target": string,        "details": [          ...        ],        "innerError": {          "code": string,.          "message": string,          "innerError": {            ...          }        }      },      ...    ]  }}
```

Error response example - JSON

```
HTTP 404 NOT FOUND{  "detailedError": {    "code": "MATRIX_NOT_FOUND",    "message": "Matrix not found for provided id."  }}
```

### Error response fields

Primary fields

Field

Description

`detailedError`  
*object*

Detailed information about the error.  
[`detailedError`](#fieldDetailedError) object

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
[`detailedError`](#fieldDetailedError) object

`innerError`  
*object*

Optional.  
A higher level of details about this error.  
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

Each of the following error codes has a scope assigned. Scope assignment is subject to change and extension. Possible scopes are:

#### `job`

*   The error code concerns the whole job.
*   It may be included in the optional [`detailedError`](#fieldDetailedError) structure.

#### `cell`

*   The error code concerns failed processing of one of the matrix cells.
*   It may be included in the optional [`data.detailedError`](#fieldDataDetailedError) structure.
*   Codes in this scope, apart from the `CELL_PROCESSING_ERROR` code, may also be included in the optional [`failureDetails`](#failuredetails-array) array.

Error code

Description

Scope

`MATRIX_NOT_FOUND`

Top level code for requests which failed with an HTTP `404` status code. May be caused by requesting the Id of a matrix job which:

*   Does not exist.
*   Doesn’t match the API Key provided.
*   Has the job result not ready.
*   Is no longer available because the [24 hour retention period](https://docs.tomtom.com/matrix-routing-v2-api/documentation/product-information/introduction#data-retention-period-notice) has passed.

`job`

`NOT_FOUND`

Top level code for requests which failed with an HTTP `404` status code, caused by providing an incorrect request path.

`job`

`BAD_REQUEST`

Top level code for requests which failed with an HTTP `400` status code. Current possible details: `BAD_ARGUMENT`

`job`

`INTERNAL_SERVER_ERROR`

Top level code for requests which failed with an HTTP `500` status code. The service cannot handle the request right now, an unexpected condition was encountered.

`job`

`SERVICE_UNAVAILABLE`

Top level code for requests which failed with an HTTP `503` status code. The service cannot handle the request right now, this is certainly a temporary state.

`job`

`BAD_ARGUMENT`

One of the request parameters did not pass validation. Current possible inner errors: `INVALID_PARAMETER_VALUE`

`job`, `cell`

`INVALID_PARAMETER_VALUE`

The value of one of the parameters is invalid.

`job`

`CELL_PROCESSING_ERROR`

This is the top level code for the `cell` scope.  
It is expected to have details about the issue in the `innerError` or `details` field.  
Current possible inner errors:

*   `OVER_TRANSACTION_LIMIT`
    
*   `UNKNOWN`
    
*   `MAP_MATCHING_FAILURE`
    
*   `NO_ROUTE_FOUND`
    
*   `BAD_ARGUMENT`
    
*   `CELL_TIMEOUT`
    
*   `OUT_OF_REGION`
    

The NO\_ROUTE\_FOUND and MAP\_MATCHING\_FAILURE cell failures are charged like successful route calculations.

`cell`

`OVER_TRANSACTION_LIMIT`

Client has exceeded the transaction limit.

`cell`

`UNKNOWN`

Unknown error has occurred.

`cell`

`MAP_MATCHING_FAILURE`

One of the input points (origin, destination) could not be matched to the map because there is no known drivable section near this point.

`cell`

`NO_ROUTE_FOUND`

No valid route could be found for the given origin and destination pair.

`cell`

`CELL_TIMEOUT`

Failed to calculate route summary for the given origin and destination pair within timeout.

`cell`

`OUT_OF_REGION`

The distance between the given origin and destination pair is too long to calculate the route, considering other requested options.  
See the API Limitations table on the [Asynchronous Matrix Submission page](https://docs.tomtom.com/matrix-routing-v2-api/documentation/asynchronous-matrix-submission#apiLimitationsTable) for more information.

`cell`