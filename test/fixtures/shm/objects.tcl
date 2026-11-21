# SPDX-License-Identifier: MPL-2.0
database -open waves -shm -event
probe -create -shm -database waves order -all -dynamic -memories -depth all
run
exit
