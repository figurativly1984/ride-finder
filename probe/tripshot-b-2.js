/*
MIT License

Copyright (c) 2007-2009 Metaweb Technologies, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

based on json.js 2006-04-28 from json.org
license: http://www.json.org/license.html

based on openlaszlo-json and hacked by nix for use in uris.
Author: Oliver Steele
Copyright: Copyright 2006 Oliver Steele.  All rights reserved.
Homepage: http://osteele.com/sources/openlaszlo/json
License: MIT License.
Version: 1.0
*/

!function(r,e){"function"==typeof define&&define.amd?define(["exports"],e):"object"==typeof exports?e(exports):e(r.rison={})}(this,function(r){var e,t,n,i,o=r;void 0===o&&(window.rison={}),o.uri_ok={"~":!0,"!":!0,"*":!0,"(":!0,")":!0,"-":!0,_:!0,".":!0,",":!0,":":!0,"@":!0,$:!0,"'":!0,"/":!0},function(){for(var r=[],e=0;e<16;e++)for(var t=0;t<16;t++)if(e+t!==0){var n=String.fromCharCode(16*e+t);/\w|[-_.\/~]/.test(n)||r.push("\\u00"+e.toString(16)+t.toString(16))}o.not_idchar=r.join("")}(),o.not_idchar=" '!:(),*@$",o.not_idstart="-0123456789",e="[^"+o.not_idstart+o.not_idchar+"][^"+o.not_idchar+"]*",o.id_ok=new RegExp("^"+e+"$"),o.next_id=new RegExp(e,"g"),o.quote=function(r){return/^[-A-Za-z0-9~!*()_.',:@$\/]*$/.test(r)?r:encodeURIComponent(r).replace(/%2C/g,",").replace(/%3A/g,":").replace(/%40/g,"@").replace(/%24/g,"$").replace(/%2F/g,"/").replace(/%20/g,"+")},t={"'":!0,"!":!0},n=function(r){r&&"function"==typeof r.toJSON&&(r=r.toJSON());var e=i[typeof r];if(e)return e(r)},i={array:function(r){var e,t,i,o=["!("],s=r.length;for(t=0;t<s;t+=1)"string"==typeof(i=n(r[t]))&&(e&&(o[o.length]=","),o[o.length]=i,e=!0);return o[o.length]=")",o.join("")},boolean:function(r){return r?"!t":"!f"},null:function(){return"!n"},number:function(r){return isFinite(r)?String(r).replace(/\+/,""):"!n"},object:function(r){if(r){if(r instanceof Array)return i.array(r);if("object"==typeof r.__prototype__&&void 0!==r.__prototype__.encode_rison)return r.encode_rison();var e,t,o,s,a,u=["("],f=[];for(t in r)f[f.length]=t;for(f.sort(),a=0;a<f.length;a++)t=f[a],"string"==typeof(o=n(r[t]))&&(e&&(u[u.length]=","),s=isNaN(parseInt(t))?i.string(t):i.number(t),u.push(s,":",o),e=!0);return u[u.length]=")",u.join("")}return"!n"},string:function(r){return""===r?"''":o.id_ok.test(r)?r:"'"+(r=r.replace(/(['!])/g,function(r,e){return t[e]?"!"+e:e}))+"'"},undefined:function(){}},o.encode=function(r){return n(r)},o.encode_object=function(r){if("object"!=typeof r||null===r||r instanceof Array)throw new Error("rison.encode_object expects an object argument");var e=i[typeof r](r);return e.substring(1,e.length-1)},o.encode_array=function(r){if(!(r instanceof Array))throw new Error("rison.encode_array expects an array argument");var e=i[typeof r](r);return e.substring(2,e.length-1)},o.encode_uri=function(r){return o.quote(i[typeof r](r))},o.decode=function(r){return new o.parser(function(r){throw Error("rison decoder error: "+r)}).parse(r)},o.decode_object=function(r){return o.decode("("+r+")")},o.decode_array=function(r){return o.decode("!("+r+")")},o.parser=function(r){this.errorHandler=r},o.parser.WHITESPACE="",o.parser.prototype.setOptions=function(r){r.errorHandler&&(this.errorHandler=r.errorHandler)},o.parser.prototype.parse=function(r){this.string=r,this.index=0,this.message=null;var e=this.readValue();return!this.message&&this.next()&&(e=this.error("unable to parse string as rison: '"+o.encode(r)+"'")),this.message&&this.errorHandler&&this.errorHandler(this.message,this.index),e},o.parser.prototype.error=function(r){"undefined"!=typeof console&&console.log("rison parser error: ",r),this.message=r},o.parser.prototype.readValue=function(){var r=this.next(),e=r&&this.table[r];if(e)return e.apply(this);var t=this.string,n=this.index-1;o.next_id.lastIndex=n;var i=o.next_id.exec(t);if(i.length>0){var s=i[0];return this.index=n+s.length,s}return r?this.error("invalid character: '"+r+"'"):this.error("empty expression")},o.parser.parse_array=function(r){for(var e,t=[];")"!==(e=r.next());){if(!e)return r.error("unmatched '!('");if(t.length)","!==e&&r.error("missing ','");else{if(","===e)return r.error("extra ','");--r.index}var n=r.readValue();if(void 0===n)return;t.push(n)}return t},o.parser.bangs={t:!0,f:!1,n:null,"(":o.parser.parse_array},o.parser.prototype.table={"!":function(){var r=this.string.charAt(this.index++);if(!r)return this.error('"!" at end of input');var e=o.parser.bangs[r];return"function"==typeof e?e.call(null,this):void 0===e?this.error('unknown literal: "!'+r+'"'):e},"(":function(){for(var r,e={},t=0;")"!==(r=this.next());){if(t)","!==r&&this.error("missing ','");else{if(","===r)return this.error("extra ','");--this.index}var n=this.readValue();if(void 0===n)return;if(":"!==this.next())return this.error("missing ':'");var i=this.readValue();if(void 0===i)return;e[n]=i,t++}return e},"'":function(){for(var r,e=this.string,t=this.index,n=t,i=[];"'"!==(r=e.charAt(t++));){if(!r)return this.error('unmatched "\'"');if("!"===r){if(n<t-1&&i.push(e.slice(n,t-1)),r=e.charAt(t++),!("!'".indexOf(r)>=0))return this.error('invalid string escape: "!'+r+'"');i.push(r),n=t}}return n<t-1&&i.push(e.slice(n,t-1)),this.index=t,1===i.length?i[0]:i.join("")},"-":function(){var r=this.string,e=this.index,t=e-1,n="int",i="-",o={"int+.":"frac","int+e":"exp","frac+e":"exp"};do{var s=r.charAt(e++);if(!s)break;"0"<=s&&s<="9"||(i.indexOf(s)>=0?i="":"exp"===(n=o[n+"+"+s.toLowerCase()])&&(i="-"))}while(n);return this.index=--e,"-"===(r=r.slice(t,e))?this.error("invalid number"):Number(r)}},function(r){for(var e=0;e<=9;e++)r[String(e)]=r["-"]}(o.parser.prototype.table),o.parser.prototype.next=function(){var r,e=this.string,t=this.index;do{if(t===e.length)return;r=e.charAt(t++)}while(o.parser.WHITESPACE.indexOf(r)>=0);return this.index=t,r}});