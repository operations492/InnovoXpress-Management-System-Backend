# Asynchronous Matrix Status | Matrix Routing v2 API

## Purpose

This endpoint lets clients check the status of a matrix job they submitted.

## Request data

### HTTPS method: `GET`

*   Constants and parameters enclosed in curly brackets { } **must be replaced** with their values.
*   Please see the following [Request parameters](#request-parameters) section with the required and optional parameters tables for their values. The generic request format is as follows.

#### URL request format

All of the following parameters are required:

```
https://{baseURL}/routing/matrix/{versionNumber}/async/{matrixJobId}?key={Your_API_Key}
```

#### URL request example

```
https://api.tomtom.com/routing/matrix/2/async/00-00000000-0000-0000-0000-000000000000-0000?key={Your_API_Key}
```

#### curl command request format

get

curl command request format

```
curl 'https://{baseURL}/routing/matrix/{versionNumber}/async/{matrixJobId}?key={Your_API_Key}'
```

The following table describes HTTP request headers of particular interest to Matrix Routing v2 service clients. **Note:** There are no required headers in this endpoint.

Optional headers

Description

Tracking-ID

Specifies an identifier for the request.

*   It can be used to trace a call.
*   The value must match the regular expression `'^[a-zA-Z0-9-]{1,100}$'`.
    
*   An example of the format that matches this regular expression is UUID: (e.g., `9ac68072-c7a4-11e8-a8d5-f2801f1b9fd1` ). For details check [RFC 4122](https://tools.ietf.org/html/rfc4122).
    
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
**Value:**

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

**Request was successful** and information about a matrix job’s current status will be returned to the client.

`403`

**Forbidden**: The API Key is missing, inactive, invalid, not entitled to use Matrix Routing v2 API, or exceeded the available quota. This can also occur when using HTTP instead of HTTPS.

`404`

**The requested resource could not be found, possible reasons**:

*   A job with the provided Id doesn’t exist.
*   A job with the provided Id did exist but the retention period has passed, and the status is no longer available.
    
*   The provided job Id and the API Key do not match.
*   URI path not found.

`405`

**Method Not Allowed**: The client used an HTTP method other than GET.

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

[Access-Control-Expose-Headers](https://developer.mozilla.org/en-US/docs/Web/HTTP/Access_control_CORS#Access-Control-Expose-Headers)

A comma separated list of HTTP header names that browsers are allowed to access.  
**Value:** Content-Length

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

An identifier for the request. If the [Tracking-ID](#trackingid-request)  
header was specified, it is replicated in the response. Otherwise, it is generated automatically by the service. It is only meant to be used for support and does not involve tracking of you or your users in any form.  
**Value:** An `identifier` for the request.

### Successful response

Response body format - JSON

```
HTTP 200 OK{  "jobId": "unique matrix job id",  "state": "Submitted" | "Validated" | "Completed" | "Failed",  "detailedError": object  "statistics": {    "totalCount": integer,    "successes": integer,    "failures": integer,    "failureDetails": [      {        "code": string,        "count": integer      },      ...    ]  }}
```

#### Example 1

Status of a job that has passed validation and is in processing:

```
HTTP 200 OK{  "jobId": "00-00000000-0000-0000-0000-000000000000-0000",  "state": "Validated"}
```

#### Example 2

Status of a job that has failed validation because of an issue in the submission request body:

```
HTTP 200 OK{  "jobId": "00-00000000-0000-0000-0000-000000000000-0000",  "state": "Failed",  "detailedError": {    "code": "BAD_REQUEST",    "message": "Bad Request",    "details": [      {        "code": "BAD_ARGUMENT",        "message": "Error(s) detected in POST body",        "target": "postBody",        "details": [          {            "code": "BAD_ARGUMENT",            "message": "Expected minimum item count: 1, found: 0",            "target": "postBody:#/origins"          }        ]      }    ]  }}
```

#### Example 3

Status of a completed job containing statistics and failed route details (if any).

Status of a completed job - JSON

```
HTTP 200 OK{  "jobId": "00-00000000-0000-0000-0000-000000000000-0000",  "state": "Completed",  "statistics": {    "totalCount": 1000,    "successes": 997,    "failures": 3,    "failureDetails": [      {        "code": "MAP_MATCHING_FAILURE",        "count": 1      },      {        "code": "UNKNOWN",        "count": 2      }    ]  }}
```

### Successful response fields

Primary fields

Field

Description

`jobId`  
*string*

Unique matrix Job Id.

`state`  
*string*

Possible values:

*   `Submitted` - request hasn’t been validated yet.
    
*   `Validated` - request is validated and it’s being processed.
    
*   `Completed` - request is processed and results are available for download.
    
*   `Failed` - processing of the given job could not be successfully completed.
    

The value list of the `state` field may be extended with new values in the future, e.g., `Paused`. Clients should be prepared for this.

Only `Completed` and `Failed` states should be considered as the final states of a job. Encountering any other state means that the client should check the status of the job again in the future.

When a job enters the `Completed` state, its result can be downloaded using the [Asynchronous Matrix Download](https://docs.tomtom.com/routing-api/documentation/matrix-routing-v2/asynchronous-matrix-download) endpoint. Moreover, the Asynchronous Matrix Status and Asynchronous Matrix Download endpoints will now return success and failure statistics for such a job.

When a job enters the `Failed` state, details of the failure will be available in the response of the Asynchronous Matrix Status endpoint. Its result will not be available for download.

`detailedError`  
*object*

Optional field, present in an HTTP 200 response body only when the state is `Failed`. For example, when an asynchronous submission has failed validation, then the details about the failure will be available in this field.

The content of this object is defined the same as in the case of an error response:  
[`detailedError`](#detailederror-object) object.

`statistics`  
*object*

Optional field, present when the state is `Completed`.  
[`statistics`](#statistics-object) object

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

Number of failed routes within this matrix caused by errors having given `code`.

### Error response

Error response format - JSON

```
{  "detailedError": {    "code": string,    "message": string,    "details": [      {        "code": string,        "message": string,        "target": string,        "details": [          ...        ],        "innerError": {          "code": string,          "message": string,          "innerError": {            ...          }        }      },      ...    ]  }}
```

Error response example - JSON

```
HTTP 404 NOT FOUND{  "detailedError": {    "code": "MATRIX_NOT_FOUND",    "message": "Matrix not found for provided id."  }}
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

Optional.  
An array of root causes (more detailed errors) that led to this error.  
[`detailedError`](#detailederror-object) object

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

*   `job` - the error code concerns the whole job.
    *   It may be included in the optional [`detailedError`](#detailederror-object) structure.
*   `cell` - the error code concerns failed processing of one of the matrix cells.
    *   Codes in this scope may be included in the optional [`failureDetails`](#failuredetails-array) array.

Error code

Description

Scope

`MATRIX_NOT_FOUND`

Top level code for requests which failed with an HTTP `404` status code. May be caused by requesting the Id of a matrix job which:

*   Does not exist.
*   Doesn’t match the API Key provided.
*   Has the job result as not ready.
*   Is no longer available because the [24 hour retention period](https://docs.tomtom.com/matrix-routing-v2-api/documentation/product-information/introduction#data-retention-period-notice) has passed.

`job`

`NOT_FOUND`

Top level code for requests which failed with an HTTP `404` status code, caused by providing an incorrect request path.

`job`

`BAD_REQUEST`

Top level code for requests which failed with an HTTP `400` status code. Most probable cause is a failed request parameters validation.  
Current possible details:

*   `BAD_ARGUMENT`
    
*   `MALFORMED_BODY`
    

`job`

`INTERNAL_SERVER_ERROR`

Top level code for requests which failed with an HTTP `500` status code. The service cannot handle the request right now, an unexpected condition was encountered.

`job`

`SERVICE_UNAVAILABLE`

Top level code for requests which failed with an HTTP `503` status code. The service cannot handle the request right now, this is certainly a temporary state.

`job`

`FORBIDDEN`

Top level code for requests which failed with an HTTP `403` status code.  
Current possible details: `OVER_TRANSACTION_LIMIT`

`job`

`BAD_ARGUMENT`

One of the request parameters did not pass validation. The optional `target` field may contain the name of the related parameter, or the location inside a JSON object in the request POST body.  
Current possible details: `BAD_ARGUMENT`  
Current possible inner errors:

*   `ILLEGAL_PARAMETER`
    
*   `MISSING_REQUIRED_PARAMETER`
    
*   `INVALID_PARAMETER_VALUE`
    

`job`, `cell`

`OVER_TRANSACTION_LIMIT`

Client has exceeded the transaction limit.

`job`, `cell`

`MALFORMED_BODY`

POST body is not properly formatted.

`job`

`ILLEGAL_PARAMETER`

Unsupported request parameter was specified.

`job`

`MISSING_REQUIRED_PARAMETER`

One of the required parameters was not provided.

`job`

`INVALID_PARAMETER_VALUE`

The value of one of the parameters is invalid.

`job`

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

The distance between the given origin and destination pair is too long to calculate the route, considering other requested options. See the API Limitations table on the [Asynchronous Matrix Submission page](https://docs.tomtom.com/matrix-routing-v2-api/documentation/asynchronous-matrix-submission#apiLimitationsTable) for more information.

`cell`