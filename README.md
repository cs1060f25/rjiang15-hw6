# Outcome

This implementation was a failure. While technically it works if you run it locally via the command 
```
node api.js
```
and then open the local host, it doesn't appear to be scalable e.g. if we had small amounts of journeys all around the world or many journeys in a concentrated spot, it would be rather unviewable.

# Feature

The goal of this prototype (and the others) is to explore various ways we can implement a user feed, where people logged in can see their posts along with the people they follow's posts.

# This implementation

This implementation is almost based off of Google Maps; people can create pins and journeys and the interface displays everyone you are allowed to see all at once.