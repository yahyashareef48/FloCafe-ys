cmake_minimum_required(VERSION 3.22.1)
project(nodebridge)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(nodebridge SHARED native-lib.cpp)
target_include_directories(nodebridge PRIVATE ${CMAKE_SOURCE_DIR}/../../../libnode/include/node)
target_link_options(nodebridge PRIVATE "-Wl,-z,max-page-size=16384")

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION
    ${CMAKE_SOURCE_DIR}/../../../libnode/bin/${ANDROID_ABI}/libnode.so)

find_library(log-lib log)
target_link_libraries(nodebridge libnode ${log-lib})
